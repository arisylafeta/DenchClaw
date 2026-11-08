import "server-only";

// The Matches tab on a supply listing, built on the product key: what this lot is, the live demand it can fill
// (matched on the key, not the listing title), and the ranked buyers the rules layer recommends.
// Read only, except the verdicts other routes write; nothing here sends anything.
import { queryPg } from "../postgres";
import { buildProductKey, keyLine, type FieldFact, type ProductKey } from "../match/product-key";
import { rankBuyers, supplyFactsFromKey, type RankedBuyerRow, type RuledOutRow } from "../match/rules";
import { countryFromText, requirementFor, scoreCandidate, vocabulary, type Candidate, type Check, type Match } from "../demand-match";
import { matchVerdicts, verdictKey, type FeedRow } from "./demand-match-supply";
import { listDemand } from "./bulk-demand";
import { getListing } from "./bulk-listings";

export type LiveDemandRow = {
  demandId: string;
  buyer: string;
  title: string;
  quantity: string | null;
  location: string | null;
  neededBy: string | null;
  verdict: "exact" | "check";
  /** The first thing that is not a clean pass, in plain words. */
  gap: string | null;
  checks: Check[];
  marginPct: number | null;
  userVerdict: "shortlist" | null;
};

export type SupplyMatchesV2Result = {
  listingId: string;
  key: ProductKey;
  /** "40 units · 50 kWh · Packs · NMC · part SU001B5189" for the collapsed header. */
  keyLine: string;
  liveDemand: LiveDemandRow[];
  /** Demands marked Not a fit on this listing, with the reason, so the count can expand. */
  liveDemandHidden: { demandId: string; buyer: string; reason: string | null }[];
  recommended: RankedBuyerRow[];
  /** Researched-only companies nobody has contacted: shown collapsed. */
  leads: RankedBuyerRow[];
  ruledOut: RuledOutRow[];
  counts: { demand: number; buyers: number; ruledOut: number };
  blocked: string | null;
};

const gapOf = (checks: Check[]) => {
  const bad = checks.find((check) => check.state === "fail")
    ?? checks.find((check) => check.state === "unknown")
    ?? checks.find((check) => check.state === "partial");
  return bad ? bad.detail : null;
};

/** The listing's title as the trade wrote it, for the key's fallback text and for display. */
function listingTitle(listing: { spec?: Record<string, unknown>; context?: Record<string, unknown>; summary: string }): string {
  const candidates = [listing.spec?.listing_title, listing.context?.listing_title];
  const found = candidates.find((value): value is string => typeof value === "string" && !!value.trim());
  return found?.trim() || listing.summary;
}

export async function listingFields(listingId: string): Promise<FieldFact[]> {
  return queryPg<FieldFact>(
    `select field_key, value, status, coalesce(alternatives, '[]'::jsonb) as alternatives
     from crm_bulk_listing_fields where bulk_listing_id = $1`, [listingId]);
}

/** The lot as one match candidate: what the demand side's scorer compares a buyer's ask against. */
export function candidateFromKey(key: ProductKey, listing: { id: string; title: string; seller: string | null; location: string | null; href: string; seen: string | null }): Candidate {
  const line = key.lines[0] ?? null;
  const kwh = line?.kwh ?? (line?.kwhMin != null && line.kwhMax != null ? (line.kwhMin + line.kwhMax) / 2 : null);
  const estimated = line?.kwh == null && kwh != null;
  const sellerPrice = key.sellerPrice;
  const price = sellerPrice ? (sellerPrice.eurPerUnit ?? (sellerPrice.eurPerKwh != null && kwh ? sellerPrice.eurPerKwh * kwh : null)) : null;
  // A range or a mixed lot is the first product line; the checks say so rather than pretending otherwise.
  return {
    key: `supply:${listing.id}`,
    source: "supply",
    title: listing.title,
    seller: listing.seller,
    make: line?.make ?? null,
    model: line?.model ?? null,
    format: line?.format ?? key.format,
    chemistry: line?.chemistry ?? key.chemistry,
    cellFormat: null,
    kwh,
    kwhEstimated: estimated,
    units: key.units,
    price,
    currency: price != null ? "EUR" : null,
    currencyAssumed: false,
    country: null,
    location: listing.location,
    soh: null,
    year: null,
    partNumber: line?.partNumber ?? key.partNumbers[0] ?? null,
    photos: 0,
    tested: false,
    verified: true,
    seen: listing.seen,
    href: listing.href,
    ai: null,
    alsoIn: [],
  };
}

type CompanyRow = {
  id: string; name: string; stage: string | null; tier: string | null; basis: string | null;
  profile: Record<string, unknown>; dossier: Record<string, unknown> | null; last_touch: string | null;
};

/**
 * Everything the Matches tab shows for one supply listing, in one read.
 * `blocked` is set when the listing is not live supply, since then there is nothing to match against.
 */
export async function supplyMatchesV2(listingId: string): Promise<SupplyMatchesV2Result | null> {
  const listing = await getListing(listingId);
  if (!listing) {
    return null;
  }
  if (listing.kind !== "supply") {
    return null;
  }
  const title = listingTitle(listing);
  const [feedRow, fields] = await Promise.all([
    queryPg<FeedRow>(
      `select id, kind, title, seller, size, location, seen, href, null::text as strength, null::text as reason
       from crm_bulk_listing_supply_feed where id = $1`, [listingId]),
    listingFields(listingId),
  ]);
  const key = buildProductKey({ fields, title });
  const summary = keyLine(key);
  if (!feedRow[0]) {
    return {
      listingId, key, keyLine: summary, liveDemand: [], liveDemandHidden: [], recommended: [], leads: [], ruledOut: [],
      counts: { demand: 0, buyers: 0, ruledOut: 0 },
      blocked: "This listing is not in the live supply feed (closed, or not an open supply or trade), so there is nothing to match.",
    };
  }
  const feed = feedRow[0];
  const locationField = fields.find((field) => field.field_key === "location")?.value ?? null;
  const supplies = supplyFactsFromKey(key, {
    title: feed.title || title,
    seller: feed.seller ?? listing.party,
    country: countryFromText(locationField ?? listing.location),
    wholeBatch: key.lines.length === 1 && (key.units ?? 0) > 1,
  });
  const candidate = candidateFromKey(key, {
    id: listingId, title: feed.title || title, seller: feed.seller ?? listing.party,
    location: feed.location ?? listing.location, href: feed.href, seen: feed.seen,
  });

  const [demand, verdicts, companies] = await Promise.all([
    listDemand(),
    matchVerdicts(listingId),
    queryPg<CompanyRow>(
      `select c.id, c.name, c.buyer_stage as stage, c.buyer_tier as tier, c.buyer_profile_basis as basis,
              c.buyer_profile as profile, c.buyer_profile -> 'dossier' as dossier
       from crm_companies c
       where c.buyer_profile <> '{}'::jsonb and c.buyer_exclusion_reason is null
         and coalesce(c.relationship_stage, '') <> 'Excluded'
         and ($1::text is null or c.id <> $1)`,
      [listing.company_id]),
  ]);
  // Current last contact per company: the newest email in or out with anyone there.
  const touches = await queryPg<{ company_id: string; last: string }>(
    `select p.company_id, max(coalesce(m.sent_at, m.created_at))::text as last
     from mail_message m join crm_people p on p.id = m.person_id
     where p.company_id = any($1::text[]) group by 1`,
    [companies.map((company) => company.id)],
  );
  const touch = new Map(touches.map((row) => [row.company_id, row.last]));

  const liveDemand: LiveDemandRow[] = [];
  const liveDemandHidden: { demandId: string; buyer: string; reason: string | null }[] = [];
  for (const row of demand) {
    if (row.status === "closed") {
      continue;
    }
    // The seller's own ask is not demand for their own stock.
    const sameParty = (!!listing.company_id && listing.company_id === row.company_id)
      || (!!listing.person_id && listing.person_id === row.person_id)
      || (!!listing.party.trim() && listing.party.trim().toLowerCase() === (row.buyer ?? "").trim().toLowerCase());
    if (sameParty) {
      continue;
    }
    const verdict = verdicts.get(verdictKey.demand(row.id));
    if (verdict?.verdict === "not_a_fit") {
      liveDemandHidden.push({ demandId: row.id, buyer: row.buyer, reason: verdict.reason ?? null });
      continue;
    }
    const requirement = requirementFor(row, vocabulary([candidate]));
    const match: Match | null = scoreCandidate(requirement, candidate);
    if (!match) {
      continue;
    }
    liveDemand.push({
      demandId: row.id, buyer: row.buyer, title: row.product_family || row.wants || row.id,
      quantity: row.quantity, location: row.location, neededBy: row.needed_by,
      verdict: match.verdict, gap: gapOf(match.checks), checks: match.checks,
      marginPct: match.economics.marginPct, userVerdict: verdict?.verdict === "shortlist" ? "shortlist" : null,
    });
  }
  liveDemand.sort((a, b) => Number(b.userVerdict === "shortlist") - Number(a.userVerdict === "shortlist")
    || (a.verdict === b.verdict ? 0 : a.verdict === "exact" ? -1 : 1)
    || (b.marginPct ?? -9) - (a.marginPct ?? -9)
    || a.buyer.localeCompare(b.buyer));

  // A company already matched to this lot through an open demand is shown there, not again as a buyer.
  const demandCompanies = new Set(demand.filter((row) => liveDemand.some((shown) => shown.demandId === row.id))
    .map((row) => row.company_id).filter((id): id is string => !!id));
  const demandNames = new Set(liveDemand.map((row) => row.buyer.trim().toLowerCase()));
  const companyVerdicts = new Map<string, "shortlist" | "not_a_fit">();
  for (const company of companies) {
    const verdict = verdicts.get(verdictKey.company(company.id));
    if (verdict?.verdict === "shortlist" || verdict?.verdict === "not_a_fit") {
      companyVerdicts.set(company.id, verdict.verdict);
    }
  }
  const buyers = companies
    .filter((company) => !demandCompanies.has(company.id) && !demandNames.has(company.name.trim().toLowerCase()))
    .map((company) => ({
      id: company.id, name: company.name, profile: company.profile ?? {},
      stage: company.stage, tier: company.tier, basis: company.basis,
      // Production last contact is the current max mail touch for the company.
      lastTouch: company.last_touch ?? touch.get(company.id) ?? null,
      // The dossier's frontmatter is the copy the rules read; there is no as-of filter on live data.
      dossier: company.dossier && typeof company.dossier === "object"
        ? { frontmatter: company.dossier as Record<string, unknown>, body: null }
        : null,
    }));
  const ranked = rankBuyers(supplies, buyers, {
    asOf: new Date().toISOString().slice(0, 10), top: 30, verdicts: companyVerdicts, key,
  });
  return {
    listingId, key, keyLine: summary, liveDemand, liveDemandHidden,
    recommended: ranked.ranked.filter((row) => !row.isLead),
    leads: ranked.ranked.filter((row) => row.isLead),
    ruledOut: ranked.ruledOut,
    counts: { demand: liveDemand.length, buyers: ranked.evaluated, ruledOut: ranked.ruledOut.length },
    blocked: null,
  };
}
