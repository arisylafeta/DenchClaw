import "server-only";

// The Matches tab on a supply listing: the lot as a product key, then one ranked list of who could take it —
// the open demand that fits it (a live ask) and the buyer companies whose dossiers fit it, researched leads last.
// Read only, except the Not a fit verdicts the route records.
import { queryPg } from "../postgres";
import { buildProductKey, keyLine, type FieldFact, type ProductKey } from "../match/product-key";
import { rankBuyers, supplyFactsFromKey, type RankedBuyerRow } from "../match/rules";
import { countryFromText, requirementFor, scoreCandidate, vocabulary, type Candidate, type Check } from "../demand-match";
import { priceLabel } from "../bulk-demand";
import { matchVerdicts, verdictKey, type FeedRow } from "./demand-match-supply";
import { listDemand } from "./bulk-demand";
import { getListing } from "./bulk-listings";
import { offersForListing } from "./match-offers";
import type { MatchesResult, MatchRow } from "../matches-types";

type CompanyRow = {
  id: string; name: string; stage: string | null; tier: string | null; basis: string | null;
  profile: Record<string, unknown>; dossier: Record<string, unknown> | null; last_touch: string | null;
};

const gapOf = (checks: Check[]) => {
  const bad = checks.find((check) => check.state === "fail")
    ?? checks.find((check) => check.state === "unknown")
    ?? checks.find((check) => check.state === "partial");
  return bad ? bad.detail : null;
};

const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

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

/** The one-line header and the full key behind it. A disputed value or a mixed lot opens itself. */
export function keyView(key: ProductKey): MatchesResult["lotKey"] {
  const lines = key.lines.map((line, index) => {
    const size = line.kwhMin != null ? `${line.kwhMin}-${line.kwhMax} kWh` : line.kwh != null ? `${Math.round(line.kwh * 100) / 100} kWh` : "kWh unknown";
    return [
      key.lines.length > 1 ? `Product ${index + 1}` : null,
      line.units != null ? `${line.units} units` : null,
      [line.make, line.model].filter(Boolean).join(" ") || null,
      size,
      line.format,
      line.chemistry,
      line.partNumber ? `part ${line.partNumber}` : null,
    ].filter(Boolean).join(" · ");
  });
  const price = key.sellerPrice
    ? `Seller price ${key.sellerPrice.currency} ${key.sellerPrice.amount.toLocaleString("en-GB")} per ${key.sellerPrice.per === "kwh" ? "kWh" : key.sellerPrice.per === "mwh" ? "MWh" : "unit"}`
    : key.priceNote;
  return {
    line: keyLine(key),
    full: [
      ...lines,
      price ?? null,
      ...key.conflicts.map((conflict) => `Disputed ${conflict.field}: ${conflict.values.join(" / ")}`),
      ...key.notes,
    ].filter((entry): entry is string => !!entry),
    open: key.mixed || key.conflicts.length > 0,
  };
}

/** The buyer's own price, only when they stated it. An estimate is not a price. */
const demandPrice = (demand: { max_price: number | null; price_currency: string | null; price_unit: string | null; price_basis: string | null }) =>
  demand.price_basis === "buyer" ? priceLabel(demand) : null;

/**
 * Everything the Matches tab shows for one supply listing, in one read: the key, and one ranked list of live asks
 * and buyer companies. Nothing is sent, and no offer is created here.
 */
export async function supplyMatchesV2(listingId: string): Promise<MatchesResult | null> {
  const listing = await getListing(listingId);
  if (!listing || listing.kind !== "supply") {
    return null;
  }
  const title = listingTitle(listing);
  const [feedRow, fields, offers] = await Promise.all([
    queryPg<FeedRow>(
      `select id, kind, title, seller, size, location, seen, href, null::text as strength, null::text as reason
       from crm_bulk_listing_supply_feed where id = $1`, [listingId]),
    listingFields(listingId),
    offersForListing(listingId),
  ]);
  const key = buildProductKey({ fields, title });
  const lotKey = keyView(key);
  if (!feedRow[0]) {
    return {
      id: listingId, kind: "supply", lotKey, rows: [], considered: 0,
      blocked: "This listing is not in the live supply feed (closed, or not an open supply or trade), so there is nothing to match.",
      errors: [],
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

  const rows: MatchRow[] = [];
  const liveDemandCompanies = new Set<string>();
  const liveDemandNames = new Set<string>();
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
    if (verdicts.get(verdictKey.demand(row.id))?.verdict === "not_a_fit") {
      continue;
    }
    const requirement = requirementFor(row, vocabulary([candidate]));
    const match = scoreCandidate(requirement, candidate);
    if (!match) {
      continue;
    }
    if (row.company_id) {
      liveDemandCompanies.add(row.company_id);
    }
    liveDemandNames.add(row.buyer.trim().toLowerCase());
    const gap = gapOf(match.checks);
    rows.push({
      key: verdictKey.demand(row.id),
      rank: 0,
      name: row.buyer,
      detail: [row.quantity, row.location, row.needed_by ? `by ${day(row.needed_by)}` : null].filter(Boolean).join(" · ") || null,
      tags: ["live ask"],
      reason: `Wants ${row.product_family || row.wants || "this product"}`,
      checks: gap ? [gap] : [],
      price: demandPrice(row),
      offer: offers.find(row.company_id, row.person_id, row.buyer),
      companyId: row.company_id,
      personId: row.person_id,
      contact: row.email ?? row.contact ?? null,
      stockId: null,
    });
  }

  const companyVerdicts = new Map<string, "shortlist" | "not_a_fit">();
  for (const company of companies) {
    const verdict = verdicts.get(verdictKey.company(company.id));
    if (verdict?.verdict === "shortlist" || verdict?.verdict === "not_a_fit") {
      companyVerdicts.set(company.id, verdict.verdict);
    }
  }
  const buyers = companies
    .filter((company) => !liveDemandCompanies.has(company.id) && !liveDemandNames.has(company.name.trim().toLowerCase()))
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

  // The main contact we can actually write to, so the offer carries a real address.
  const contacts = await queryPg<{ company_id: string; person_id: string; email: string | null }>(
    `select distinct on (p.company_id) p.company_id, p.id as person_id, p.email
     from crm_people p join crm_companies c on c.id = p.company_id
     where p.company_id = any($1::text[])
     order by p.company_id,
       (p.email is not null and not coalesce(p.email_opted_out, false)) desc,
       (p.id = c.buyer_main_contact_id) desc, p.full_name`,
    [ranked.ranked.map((row) => row.companyId)],
  );
  const contactOf = new Map(contacts.map((row) => [row.company_id, row]));

  // A company with no product overlap at all is not a match; the tab shows the ones the key actually reached.
  for (const buyer of ranked.ranked.filter((row) => row.productTier > 0)) {
    rows.push(buyerRow(buyer, contactOf.get(buyer.companyId) ?? null, touch.get(buyer.companyId) ?? null, offers));
  }
  const listed = rows.map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    id: listingId,
    kind: "supply",
    lotKey,
    rows: listed,
    considered: demand.length + ranked.evaluated,
    blocked: listed.length ? null : "Nothing fits yet. Add a dossier or a listing field to widen the match.",
    errors: [],
    units: key.units ?? null,
  };
}

function buyerRow(buyer: RankedBuyerRow, contact: { person_id: string; email: string | null } | null, lastTouch: string | null, offers: Awaited<ReturnType<typeof offersForListing>>): MatchRow {
  return {
    key: verdictKey.company(buyer.companyId),
    rank: 0,
    name: buyer.name,
    detail: lastTouch ? `Last contact ${day(lastTouch)}` : "No contact yet",
    tags: buyer.isLead ? ["lead"] : [],
    reason: buyer.fits,
    checks: buyer.checks,
    price: buyer.priceBand,
    offer: offers.find(buyer.companyId, contact?.person_id ?? null, buyer.name),
    companyId: buyer.companyId,
    personId: contact?.person_id ?? null,
    contact: contact?.email ?? null,
    stockId: null,
  };
}
