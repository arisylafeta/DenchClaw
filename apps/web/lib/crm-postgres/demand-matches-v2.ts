import "server-only";

// The Matches tab on a request, answering "where can we get this": one ranked list across our live listings, the
// marketplace and unlisted supplier stock, with the same unit never counted twice. Reuses the product key and the
// demand-side scorer, so one unit of stock is judged the same way everywhere.
import { queryPg } from "../postgres";
import { requestCodeHit, requirementFor, scoreCandidate, vocabulary, type Candidate, type Match, type Requirement } from "../demand-match";
import { fitMarks, holdsLine, sourceLine, unitsPhrase } from "../match/fit-marks";
import { inventoryFor } from "./demand-match-supply";
import { getDemand } from "./bulk-demand";
import { offersForListing } from "./match-offers";
import type { FitMark, MatchesResult, MatchRow, MatchTag } from "../matches-types";

type DemandSource = "ourListings" | "marketplace" | "unlistedStock";

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

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

/** Unlisted supplier stock: status `opportunity` only, and never a unit that is already on a listing. */
export type StockRow = {
  id: string; company_id: string | null; person_id: string; supplier: string | null;
  make: string | null; model: string | null; format: string | null; chemistry: string | null;
  capacity_kwh: number | null; quantity: number | null; price_eur: number | null;
  location: string | null; country: string | null; seen_on: string | null; title: string;
  /** `details.quantity_available`, when the source states one. */
  quantity_available: number | null;
  /** `details.attributes.quantity_stated`: false means the quantity column is a placeholder. */
  quantity_stated: boolean | null;
  soh_percent: number | null; year: number | null; part_numbers: string[] | null;
  supplier_ref: string | null; description: string | null;
  /** `crm_stock_opportunities.source` ("supplier list", "supplier email", "website", "ebay", ...). */
  source: string | null;
  /** What the evidence says the source was, for telling a catalogue from a stock list. */
  evidence_source: string | null;
  observed_on: string | null;
};

const NUMBER = (path: string) => `case when jsonb_typeof(s.details->${path}) = 'number' then (s.details->${path})::text::numeric::float8
                 when (s.details->${path}) #>> '{}' ~ '^[0-9]+(\\.[0-9]+)?$' then ((s.details->${path}) #>> '{}')::numeric::float8 end`;

// Lines with no make are read too: a cell or part code from the request can still name them (the INR21700-50E line
// keeps its code in supplier_ref). Which of them may be considered is decided per request, in demandMatchesV2.
async function unlistedStock(): Promise<StockRow[]> {
  return queryPg<StockRow>(
    `select s.id, s.company_id, s.person_id, coalesce(c.name, p.full_name) as supplier, s.title,
            nullif(trim(s.details->>'make'), '') as make, s.details->>'model' as model, s.details->>'format' as format,
            s.details->>'chemistry' as chemistry,
            ${NUMBER("'capacity_kwh'")} as capacity_kwh,
            s.quantity::float8 as quantity,
            ${NUMBER("'quantity_available'")} as quantity_available,
            case s.details->'attributes'->>'quantity_stated' when 'false' then false when 'true' then true end as quantity_stated,
            case when jsonb_typeof(s.details->'price_eur') = 'number' then (s.details->'price_eur')::text::numeric::float8 end as price_eur,
            ${NUMBER("'soh_percent'")} as soh_percent,
            case when (s.details->>'year') ~ '^(19|20)[0-9]{2}$' then (s.details->>'year')::int end as year,
            case when jsonb_typeof(s.details->'part_numbers') = 'array'
                 then array(select jsonb_array_elements_text(s.details->'part_numbers')) end as part_numbers,
            s.supplier_ref, s.description, s.source, s.details->'evidence'->>'source' as evidence_source,
            s.observed_on::text as observed_on,
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
     order by s.updated_at desc`);
}

const STOCK_FORMAT: Record<string, Candidate["format"]> = {
  pack: "Packs", packs: "Packs", module: "Modules", modules: "Modules",
  cell: "Cells", cells: "Cells", system: "Systems", systems: "Systems",
};

/**
 * The quantity a stock line states. `quantity_stated = false` is not stated; `quantity_available` wins when present;
 * otherwise the column, where a lone 1 is marked bare (the scorer reads it as "not stated" on a cell or module ask).
 */
export function stockUnits(row: Pick<StockRow, "quantity" | "quantity_available" | "quantity_stated">): { units: number | null; bare: boolean } {
  if (row.quantity_stated === false) {
    return { units: null, bare: false };
  }
  if (row.quantity_available != null) {
    return { units: row.quantity_available, bare: false };
  }
  if (row.quantity == null) {
    return { units: null, bare: false };
  }
  return { units: row.quantity, bare: row.quantity === 1 && row.quantity_stated !== true };
}

/** Where a stock line came from, in words a trader uses. */
export function stockSourceKind(row: Pick<StockRow, "source" | "evidence_source" | "title" | "description">): string | null {
  const source = (row.source ?? "").toLowerCase();
  const said = `${row.evidence_source ?? ""} ${row.title} ${row.description ?? ""}`;
  if (source === "supplier list") {
    return /catalog/i.test(row.evidence_source ?? "") ? "catalogue" : "stock list";
  }
  if (source === "supplier email" || /\b(seller|supplier) email\b/i.test(said)) {
    return "email";
  }
  if (source === "ebay") {
    return "eBay listing";
  }
  if (source === "website") {
    return "salvage listing";
  }
  if (source === "web research") {
    return "web research";
  }
  return source ? "stock list" : null;
}

export function stockCandidate(row: StockRow): Candidate {
  const format = STOCK_FORMAT[(row.format ?? "").toLowerCase()] ?? (/bess|container|system/i.test(row.format ?? "") ? "Systems" : null);
  const { units, bare } = stockUnits(row);
  const partNumbers = (row.part_numbers ?? []).filter((part) => !!part?.trim());
  return {
    key: `stock:${row.id}`, source: "trade", title: row.title, seller: row.supplier,
    make: row.make, model: row.model, format, chemistry: row.chemistry, cellFormat: null,
    kwh: row.capacity_kwh, kwhEstimated: false, units, unitsBare: bare,
    price: row.price_eur, currency: row.price_eur != null ? "EUR" : null, currencyAssumed: false,
    country: row.country, location: row.location, soh: row.soh_percent, year: row.year, partNumber: partNumbers[0] ?? null,
    partNumbers, supplierRef: row.supplier_ref, description: row.description,
    sourceKind: stockSourceKind(row), observedOn: row.observed_on,
    photos: 0, tested: false, verified: row.company_id != null, seen: row.seen_on,
    href: `/trades/stock/${row.id}`, ai: null, alsoIn: [],
  };
}

const TAG_FOR: Record<DemandSource, MatchTag> = {
  ourListings: "our listing",
  marketplace: "marketplace",
  unlistedStock: "unlisted stock",
};

/** The counterparty's own price, only when the row states one. A derived €/kWh is not a firm price. */
function firmPrice(candidate: Candidate): string | null {
  if (candidate.price == null || !candidate.currency || candidate.currencyAssumed) {
    return null;
  }
  const amount = candidate.price.toLocaleString("en-GB", { maximumFractionDigits: candidate.price < 10 ? 2 : 0 });
  return `${candidate.currency} ${amount}`;
}

/** Why this unit fits, citing the product it matched on rather than the request's words. */
function reasonFor(match: Match, candidate: Candidate): string {
  const product = match.checks.find((check) => check.key === "model" && check.state === "pass")
    ?? match.checks.find((check) => check.key === "product" && check.state === "pass");
  if (product) {
    return `${product.label} matches: ${product.detail}`;
  }
  return [candidate.make, candidate.model].filter(Boolean).join(" ") || candidate.title;
}

// The checks each fit mark already shows, so the row does not say the same thing twice.
const MARKED: Record<string, string[]> = {
  model: ["product", "model"], size: ["product"], format: ["format"], capacity: ["capacity"], chemistry: ["chemistry"],
  quantity: ["quantity"], price: ["price"],
};

/** What to check on a request row beyond its marks: an open gap no mark shows, then the evidence to ask for. */
function requestChecks(match: Match, missing: string[], marks: FitMark[]): string[] {
  const shown = new Set(marks.flatMap((mark) => MARKED[mark.key] ?? []));
  const gaps = match.checks
    .filter((check) => check.state !== "pass" && !shown.has(check.key) && !check.detail.startsWith("AI:"))
    .map((check) => check.detail.replace(/\s*\(group with others below\)/i, ""));
  return [...new Set([...gaps, missing.length ? `Ask for ${missing.join(", ")}` : null].filter((entry): entry is string => !!entry))].slice(0, 3);
}

type Identity = { companyId: string | null; personId: string | null; contact: string | null };

/** Who to write to for a `trade:` / `supply:` row, a `stock:` row or a `listing:` row (no CRM identity). */
async function identities(keys: string[]): Promise<Map<string, Identity>> {
  const listings = keys.filter((key) => /^(trade|supply):/.test(key)).map((key) => key.slice(key.indexOf(":") + 1));
  const stock = keys.filter((key) => key.startsWith("stock:")).map((key) => key.slice("stock:".length));
  const [listingRows, stockRows] = await Promise.all([
    listings.length ? queryPg<{ id: string; company_id: string | null; person_id: string | null; contact: string | null; email: string | null }>(
      `select id, company_id, person_id, contact, email from crm_bulk_listings where id = any($1::text[])`, [listings]) : [],
    stock.length ? queryPg<{ id: string; company_id: string | null; person_id: string }>(
      `select id, company_id, person_id from crm_stock_opportunities where id = any($1::text[])`, [stock]) : [],
  ]);
  const byListing = new Map(listingRows.map((row) => [row.id, row]));
  const byStock = new Map(stockRows.map((row) => [row.id, row]));
  const personIds = [...listingRows.map((row) => row.person_id), ...stockRows.map((row) => row.person_id)].filter((id): id is string => !!id);
  const people = personIds.length
    ? await queryPg<{ id: string; email: string | null }>(`select id, email from crm_people where id = any($1::text[])`, [personIds])
    : [];
  const emailOf = new Map(people.map((row) => [row.id, row.email]));

  const out = new Map<string, Identity>();
  for (const key of keys) {
    const id = key.slice(key.indexOf(":") + 1);
    if (key.startsWith("stock:")) {
      const row = byStock.get(id);
      out.set(key, { companyId: row?.company_id ?? null, personId: row?.person_id ?? null, contact: row ? emailOf.get(row.person_id) ?? null : null });
    } else if (byListing.has(id)) {
      const row = byListing.get(id)!;
      out.set(key, { companyId: row.company_id, personId: row.person_id, contact: row.email ?? row.contact ?? (row.person_id ? emailOf.get(row.person_id) ?? null : null) });
    }
  }
  return out;
}

/** The one-line "Matched on" header for a request, and the full requirement behind it. */
function requirementView(requirement: Requirement, evidence: string[], demand: { spec?: Record<string, unknown>; quantity?: string | null; location?: string | null; product_family?: string | null; wants: string }): MatchesResult["lotKey"] {
  const size = requirement.kwhNeeded != null ? `${requirement.kwhNeeded} kWh` : null;
  const price = requirement.buyerEurPerKwh != null ? `buys up to €${requirement.buyerEurPerKwh}/kWh`
    : requirement.buyerEurPerUnit != null ? `buys up to €${requirement.buyerEurPerUnit}/unit` : null;
  // The ask in its own words reads better than lower-case match tokens ("mg", "kona"); the full key carries the fields.
  const asked = (demand.product_family || demand.wants).replace(/\s+/g, " ").trim();
  const capacity = requirement.kwh && "options" in requirement.kwh
    ? requirement.kwh.options.map((option) => `${option} kWh`).join(" / ")
    : size;
  return {
    line: asked.length > 90 ? `${asked.slice(0, 89).trimEnd()}…` : asked,
    full: [
      requirement.pinned.length ? `Matched on ${requirement.pinned.join(" · ")}` : null,
      requirement.unitsRange ? `Needs ${requirement.unitsRange.min.toLocaleString("en-GB")}–${requirement.unitsRange.max.toLocaleString("en-GB")} units`
        : requirement.unitsNeeded != null ? `Needs ${requirement.unitsNeeded.toLocaleString("en-GB")} units` : demand.quantity ?? null,
      capacity ? `Capacity ${capacity}` : null,
      price,
      requirement.country ? `Delivered to ${requirement.country}` : demand.location,
      evidence.length ? `Evidence: ${evidence.map((item) => EVIDENCE_LABEL[item] ?? item).join(", ")}` : null,
    ].filter((entry): entry is string => !!entry),
    open: demand.spec?.mixed_ok === true,
  };
}

export async function demandMatchesV2(demandId: string): Promise<MatchesResult | null> {
  const demand = await getDemand(demandId);
  if (!demand) {
    return null;
  }
  const [inventory, stock, offers] = await Promise.all([
    inventoryFor(demandId),
    unlistedStock(),
    offersForListing(demandId),
  ]);
  const { candidates, hidden, verdicts, errors } = inventory;
  // One requirement per request, from the same vocabulary the demand tab already uses: what a seller writes in a
  // make or model. Stock rows are then judged against it, never allowed to redefine the ask.
  const requirement = requirementFor(demand, vocabulary(candidates));
  // A stock line with no make is considered only when a code from the request names it; otherwise hundreds of
  // 12 V and AGM lines with no make would reach pack requests.
  const stockCandidates = stock.map(stockCandidate).filter((candidate) => candidate.make || requestCodeHit(requirement, candidate));
  const evidence = Array.isArray(demand.spec?.evidence) ? (demand.spec.evidence as string[]) : [];

  type Scored = { candidate: Candidate; source: DemandSource; match: Match; missing: string[] };
  const scored: Scored[] = [];
  const consider = (candidate: Candidate, source: DemandSource) => {
    const verdict = verdicts.get(candidate.key);
    if (verdict?.verdict === "not_a_fit" || hidden.has(candidate.key)) {
      return;
    }
    const match = scoreCandidate(requirement, candidate);
    if (!match) {
      return;
    }
    // The match's candidate carries the honest quantity ("not stated" for a placeholder 1).
    scored.push({ candidate: match.candidate, source, match, missing: evidenceMissing(evidence, candidate) });
  };
  for (const candidate of candidates) {
    consider(candidate, candidate.source === "marketplace" ? "marketplace" : "ourListings");
  }
  for (const candidate of stockCandidates) {
    consider(candidate, "unlistedStock");
  }

  const rank = (row: Scored) => (row.missing.length ? 1 : row.match.verdict === "exact" ? 0 : 2);
  const order = (a: Scored, b: Scored) => rank(a) - rank(b)
    || (b.match.economics.marginPct ?? -9) - (a.match.economics.marginPct ?? -9)
    || (b.candidate.units ?? 0) - (a.candidate.units ?? 0)
    || a.candidate.title.localeCompare(b.candidate.title);

  const identity = await identities(scored.map((row) => row.candidate.key));
  const rows: MatchRow[] = scored.toSorted(order).map(({ candidate, source, match, missing }, index) => {
    const who = identity.get(candidate.key) ?? { companyId: null, personId: null, contact: null };
    const price = firmPrice(candidate);
    const marks = fitMarks(requirement, match, { price });
    return {
      key: candidate.key,
      rank: index + 1,
      name: candidate.seller ?? "Unknown seller",
      detail: [
        candidate.units != null ? unitsPhrase(candidate.units, candidate.format) : "Quantity not stated",
        candidate.location ?? candidate.country,
        candidate.seen ? `seen ${day(candidate.seen)}` : null,
      ].filter(Boolean).join(" · "),
      tags: [TAG_FOR[source]],
      reason: reasonFor(match, candidate),
      checks: requestChecks(match, missing, marks),
      price,
      offer: offers.find(who.companyId, who.personId, candidate.seller ?? ""),
      companyId: who.companyId,
      personId: who.personId,
      contact: who.contact,
      stockId: candidate.key.startsWith("stock:") ? candidate.key.slice("stock:".length) : null,
      holds: holdsLine(candidate),
      source: [sourceLine(candidate), candidate.location ?? candidate.country].filter(Boolean).join(" · ") || null,
      fit: marks,
    };
  });
  const need = requirement.unitsNeeded;

  return {
    id: demandId,
    kind: "demand",
    lotKey: requirementView(requirement, evidence, demand),
    rows,
    considered: candidates.length + stockCandidates.length,
    blocked: rows.length ? null : "Nothing fits yet. Add a dossier or a listing field to widen the match.",
    errors,
    // Only stated quantities count towards the need; a line that has not said is counted apart.
    coverage: need ? {
      stated: scored.reduce((sum, row) => sum + (row.candidate.units ?? 0), 0),
      need,
      unstated: scored.filter((row) => row.candidate.units == null).length,
      needMax: requirement.unitsRange?.max ?? null,
    } : null,
  };
}
