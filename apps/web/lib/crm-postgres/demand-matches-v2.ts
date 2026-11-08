import "server-only";

// The Matches tab on a request, answering "where can we get this": ranked supply from every source we hold,
// grouped so the same stock is never counted twice, plus the sellers most likely to have it.
// Reuses the product key and the demand-side scorer, so one unit of stock is judged the same way everywhere.
import { queryPg } from "../postgres";
import { requirementFor, scoreCandidate, vocabulary, type Candidate, type Check, type Match, type Requirement } from "../demand-match";
import { inventoryFor } from "./demand-match-supply";
import { getDemand } from "./bulk-demand";

export type DemandSource = "ourListings" | "marketplace" | "unlistedStock";

export type DemandMatchRow = {
  key: string;
  source: DemandSource;
  title: string;
  seller: string | null;
  make: string | null;
  model: string | null;
  format: string | null;
  chemistry: string | null;
  kwh: number | null;
  units: number | null;
  price: number | null;
  currency: string | null;
  eurPerKwh: number | null;
  marginPct: number | null;
  verdict: "exact" | "check";
  /** The first thing that is not a clean pass, in plain words. */
  gap: string | null;
  checks: Check[];
  /** What the request asked to see that this row cannot prove yet. */
  evidenceMissing: string[];
  location: string | null;
  country: string | null;
  seen: string | null;
  href: string | null;
  userVerdict: "shortlist" | "not_a_fit" | null;
};

export type GoFindRow = {
  companyId: string | null;
  personId: string | null;
  name: string;
  /** "Has offered MG ZS packs before (2 stock rows, last seen 2026-10-02)". */
  why: string;
  lastSeen: string | null;
  matches: number;
  sources: ("stock" | "supply")[];
};

export type DemandMatchesV2Result = {
  demandId: string;
  requirement: {
    pinned: string[];
    unitsNeeded: number | null;
    kwhNeeded: number | null;
    buyerEurPerKwh: number | null;
    buyerEurPerUnit: number | null;
    country: string | null;
    evidence: string[];
  };
  sources: { ourListings: DemandMatchRow[]; marketplace: DemandMatchRow[]; unlistedStock: DemandMatchRow[]; goFind: GoFindRow[] };
  /** The single row to lead with: the first row of the same order the lists use. */
  bestSource: { key: string; source: DemandSource; title: string; verdict: "exact" | "check"; why: string } | null;
  counts: { rows: number; exact: number; /** Rows that fit before the per-source cap. */ matched: number; hidden: number; considered: number };
  blocked: string | null;
  errors: string[];
};

const ROWS_PER_SOURCE = 25;
const GOFIND_SHOWN = 12;

const EVIDENCE_LABEL: Record<string, string> = {
  tested_soh: "a tested SoH reading",
  bms_access: "BMS access",
  bms_data: "BMS data",
  label_photos: "label photos",
  pack_photos: "pack photos",
  interior_photos: "interior photos",
  sds: "an SDS",
  un383: "a UN38.3 report",
  test_report: "a test report",
  sample_pack: "a sample pack",
  provenance: "provenance",
  waste_code: "the waste code",
};

/**
 * What the request's evidence bar still needs from this row. A fact we hold on the CRM row counts;
 * anything else has to be asked for, so the row is Check rather than Exact.
 */
export function evidenceMissing(evidence: string[], candidate: Candidate): string[] {
  const missing: string[] = [];
  for (const item of evidence) {
    if (item === "tested_soh") {
      if (!(candidate.tested || candidate.soh != null)) {
        missing.push(EVIDENCE_LABEL.tested_soh);
      }
      continue;
    }
    if (item === "label_photos" || item === "pack_photos" || item === "interior_photos") {
      if (candidate.photos <= 0) {
        missing.push(EVIDENCE_LABEL[item]);
      }
      continue;
    }
    missing.push(EVIDENCE_LABEL[item] ?? item);
  }
  return missing;
}

const gapOf = (checks: Check[]) => {
  const bad = checks.find((check) => check.state === "fail")
    ?? checks.find((check) => check.state === "unknown")
    ?? checks.find((check) => check.state === "partial");
  return bad ? bad.detail : null;
};

/** Unlisted supplier stock: status `opportunity` only, and never a unit that is already on a listing. */
type StockRow = {
  id: string; company_id: string | null; person_id: string; supplier: string | null;
  make: string | null; model: string | null; format: string | null; chemistry: string | null;
  capacity_kwh: number | null; quantity: number | null; price_eur: number | null;
  location: string | null; country: string | null; seen_on: string | null; title: string;
};

async function unlistedStock(): Promise<StockRow[]> {
  return queryPg<StockRow>(
    `select s.id, s.company_id, s.person_id, coalesce(c.name, p.full_name) as supplier, s.title,
            s.details->>'make' as make, s.details->>'model' as model, s.details->>'format' as format,
            s.details->>'chemistry' as chemistry,
            case when jsonb_typeof(s.details->'capacity_kwh') = 'number' then (s.details->'capacity_kwh')::text::numeric::float8
                 when (s.details->'capacity_kwh') #>> '{}' ~ '^[0-9]+(\\.[0-9]+)?$' then ((s.details->'capacity_kwh') #>> '{}')::numeric::float8 end as capacity_kwh,
            coalesce(s.quantity, 1)::float8 as quantity,
            case when jsonb_typeof(s.details->'price_eur') = 'number' then (s.details->'price_eur')::text::numeric::float8 end as price_eur,
            s.location, coalesce(nullif(c.country, ''), nullif(s.location, '')) as country,
            coalesce(s.details->'sync'->>'lastSeen', s.observed_on::text, s.updated_at::date::text) as seen_on
     from crm_stock_opportunities s
     left join crm_companies c on c.id = s.company_id
     left join crm_people p on p.id = s.person_id
     where s.status = 'opportunity'
       and s.marketplace_listing_id is null
       and s.bulk_listing_id is null
       and coalesce(s.details->>'deliver', 'true') <> 'false'
       and coalesce(s.details->'availability'->>'state', '') not in ('sold', 'not_found', 'gone')
       and nullif(trim(s.details->>'make'), '') is not null
     order by s.updated_at desc`);
}

const STOCK_FORMAT: Record<string, Candidate["format"]> = {
  pack: "Packs", packs: "Packs", module: "Modules", modules: "Modules",
  cell: "Cells", cells: "Cells", system: "Systems", systems: "Systems",
};

function stockCandidate(row: StockRow): Candidate {
  const format = STOCK_FORMAT[(row.format ?? "").toLowerCase()] ?? (/bess|container|system/i.test(row.format ?? "") ? "Systems" : null);
  return {
    key: `stock:${row.id}`, source: "trade", title: row.title, seller: row.supplier,
    make: row.make, model: row.model, format, chemistry: row.chemistry, cellFormat: null,
    kwh: row.capacity_kwh, kwhEstimated: false, units: row.quantity,
    price: row.price_eur, currency: row.price_eur != null ? "EUR" : null, currencyAssumed: false,
    country: row.country, location: row.location, soh: null, year: null, partNumber: null,
    photos: 0, tested: false, verified: row.company_id != null, seen: row.seen_on,
    href: `/trades/stock/${row.id}`, ai: null, alsoIn: [],
  };
}

/** One candidate as the tab's row, with the request's evidence bar applied to the verdict. */
function rowOf(candidate: Candidate, source: DemandSource, match: Match, evidence: string[], userVerdict: DemandMatchRow["userVerdict"]): DemandMatchRow {
  const missing = evidenceMissing(evidence, candidate);
  const checks = missing.length
    ? [...match.checks, { key: "product" as const, label: "Evidence", state: "unknown" as const, detail: `Ask for ${missing.join(", ")}` }]
    : match.checks;
  return {
    key: candidate.key, source, title: candidate.title, seller: candidate.seller,
    make: candidate.make, model: candidate.model, format: candidate.format ?? null,
    chemistry: candidate.chemistry, kwh: candidate.kwh, units: candidate.units,
    price: candidate.price, currency: candidate.currency,
    eurPerKwh: match.economics.sellerEurPerKwh, marginPct: match.economics.marginPct,
    verdict: missing.length ? "check" : match.verdict,
    gap: missing.length ? `Ask for ${missing[0]}` : gapOf(match.checks),
    checks, evidenceMissing: missing,
    location: candidate.location, country: candidate.country, seen: candidate.seen,
    href: candidate.href, userVerdict,
  };
}

const sourceRank = (row: DemandMatchRow) => (row.userVerdict === "shortlist" ? 0 : row.verdict === "exact" ? 1 : 2);
const rowOrder = (a: DemandMatchRow, b: DemandMatchRow) => sourceRank(a) - sourceRank(b)
  || (b.marginPct ?? -9) - (a.marginPct ?? -9)
  || (b.units ?? 0) - (a.units ?? 0)
  || a.title.localeCompare(b.title);

/** A seller who has offered this make or product before: where to ask first. */
async function goFind(requirement: Requirement): Promise<GoFindRow[]> {
  const terms = [...new Set([...requirement.makeWords, ...requirement.products.flatMap((product) => product.anyOf)])]
    .map((term) => term.trim().toLowerCase()).filter((term) => term.length > 1);
  if (!terms.length) {
    return [];
  }
  const [stock, supply] = await Promise.all([
    queryPg<{ company_id: string | null; person_id: string; name: string; make: string | null; model: string | null; last_seen: string | null }>(
      `select s.company_id, s.person_id, coalesce(c.name, p.full_name, 'Unknown') as name,
              s.details->>'make' as make, s.details->>'model' as model,
              coalesce(s.details->'sync'->>'lastSeen', s.observed_on::text, s.updated_at::date::text) as last_seen
       from crm_stock_opportunities s
       left join crm_companies c on c.id = s.company_id
       left join crm_people p on p.id = s.person_id
       where s.status <> 'rejected' and nullif(trim(s.details->>'make'), '') is not null`),
    queryPg<{ company_id: string | null; person_id: string | null; name: string; make: string | null; model: string | null; last_seen: string | null }>(
      `select l.company_id, l.person_id, coalesce(c.name, p.full_name, l.party) as name,
              max(case when f.field_key = 'model' then f.value end) as model,
              l.observed_on::text as last_seen
       from crm_bulk_listings l
       left join crm_companies c on c.id = l.company_id
       left join crm_people p on p.id = l.person_id
       left join crm_bulk_listing_fields f on f.bulk_listing_id = l.id and f.field_key = 'model'
       where l.kind = 'supply'
       group by l.id, l.company_id, l.person_id, c.name, p.full_name, l.party, l.observed_on`),
  ]);
  const found = new Map<string, GoFindRow & { labels: Set<string> }>();
  const consider = (row: { company_id: string | null; person_id: string | null; name: string; make: string | null; model: string | null; last_seen: string | null }, kind: "stock" | "supply") => {
    const text = ` ${[row.make, row.model].filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    const hit = terms.find((term) => text.includes(` ${term} `) || (term.includes(" ") && text.includes(term)));
    if (!hit) {
      return;
    }
    const id = row.company_id ?? `person:${row.person_id}`;
    const seen = row.last_seen ? row.last_seen.slice(0, 10) : null;
    // What they offered, in their own words, so the reason reads like a fact rather than a search term.
    const label = [row.make, row.model].filter(Boolean).join(" ").trim() || hit;
    const existing = found.get(id);
    if (!existing) {
      found.set(id, {
        companyId: row.company_id, personId: row.person_id, name: row.name, why: "", lastSeen: seen,
        matches: 1, sources: [kind], labels: new Set([label]),
      });
      return;
    }
    existing.matches += 1;
    existing.labels.add(label);
    if (!existing.sources.includes(kind)) {
      existing.sources.push(kind);
    }
    if (seen && (!existing.lastSeen || seen > existing.lastSeen)) {
      existing.lastSeen = seen;
    }
  };
  for (const row of stock) {
    consider(row, "stock");
  }
  for (const row of supply) {
    consider(row, "supply");
  }
  return [...found.values()]
    .map(({ labels, ...row }) => {
      const shown = [...labels].slice(0, 2);
      const more = labels.size - shown.length;
      const what = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
      const where = row.sources.includes("supply") ? "past lots" : "stock rows";
      return {
        ...row,
        why: `Has offered ${what} before (${row.matches} ${where}${row.lastSeen ? `, last seen ${row.lastSeen}` : ""})`,
      };
    })
    .toSorted((a, b) => b.matches - a.matches || (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))
    .slice(0, GOFIND_SHOWN);
}

export async function demandMatchesV2(demandId: string): Promise<DemandMatchesV2Result | null> {
  const demand = await getDemand(demandId);
  if (!demand) {
    return null;
  }
  const { candidates, hidden, verdicts, errors } = await inventoryFor(demandId);
  const stock = await unlistedStock();
  const stockCandidates = stock.map(stockCandidate);
  // One requirement per request, from the same vocabulary the demand tab already uses: what a seller writes in a
  // make or model. Stock rows are then judged against it, never allowed to redefine the ask.
  const requirement = requirementFor(demand, vocabulary(candidates));
  const evidence = Array.isArray(demand.spec?.evidence) ? (demand.spec.evidence as string[]) : [];

  let rows: DemandMatchRow[] = [];
  const consider = (candidate: Candidate, source: DemandSource) => {
    const verdict = verdicts.get(candidate.key);
    if (verdict?.verdict === "not_a_fit") {
      return;
    }
    const match = scoreCandidate(requirement, candidate);
    if (!match) {
      return;
    }
    rows.push(rowOf(candidate, source, match, evidence, verdict?.verdict === "shortlist" ? "shortlist" : null));
  };
  for (const candidate of candidates) {
    if (hidden.has(candidate.key)) {
      continue;
    }
    consider(candidate, candidate.source === "marketplace" ? "marketplace" : "ourListings");
  }
  for (const candidate of stockCandidates) {
    consider(candidate, "unlistedStock");
  }
  rows = rows.toSorted(rowOrder);

  const best = rows[0] ?? null;
  const shown = {
    ourListings: rows.filter((row) => row.source === "ourListings").slice(0, ROWS_PER_SOURCE),
    marketplace: rows.filter((row) => row.source === "marketplace").slice(0, ROWS_PER_SOURCE),
    unlistedStock: rows.filter((row) => row.source === "unlistedStock").slice(0, ROWS_PER_SOURCE),
  };
  return {
    demandId,
    requirement: {
      pinned: requirement.pinned, unitsNeeded: requirement.unitsNeeded, kwhNeeded: requirement.kwhNeeded,
      buyerEurPerKwh: requirement.buyerEurPerKwh, buyerEurPerUnit: requirement.buyerEurPerUnit,
      country: requirement.country, evidence,
    },
    sources: { ...shown, goFind: await goFind(requirement) },
    bestSource: best
      ? { key: best.key, source: best.source, title: best.title, verdict: best.verdict, why: best.gap ? `${best.title}: ${best.gap}` : best.title }
      : null,
    counts: {
      rows: shown.ourListings.length + shown.marketplace.length + shown.unlistedStock.length,
      exact: [...shown.ourListings, ...shown.marketplace, ...shown.unlistedStock].filter((row) => row.verdict === "exact").length,
      matched: rows.length,
      hidden: hidden.size,
      considered: candidates.length + stockCandidates.length,
    },
    blocked: rows.length ? null : "Nothing we hold fits this ask yet: no listing, marketplace unit or stock row matches the ask.",
    errors,
  };
}
