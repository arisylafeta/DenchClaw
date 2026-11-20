import "server-only";

// The Matches tab on a supply listing: the lot as a product key, then one ranked list of who could take it —
// the open demand that fits it (a live ask) and the buyer companies whose dossiers fit it, researched leads last.
// Read only, except the Not a fit verdicts the route records.
import { queryPg } from "../postgres";
import { buildProductKey, keyLine, type FieldFact, type ProductKey } from "../match/product-key";
import { rankBuyers, shortDate, supplyFactsFromKey, type BuyerLine, type RankedBuyerRow, type RuledOutRow } from "../match/rules";
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

/**
 * `MATCH_BUYER_LINES=off` restores the ranking exactly as it was before buyer interest lines. On by default.
 * Production runs self-hosted and reads this once per request from the process environment, so switching it needs a
 * restart through the deploy tool (scripts/denchclaw-deploy.py); rolling the feature back is a deploy rollback.
 */
export const buyerLinesEnabled = () => (process.env.MATCH_BUYER_LINES ?? "on").trim().toLowerCase() !== "off";

type LineRow = {
  company_id: string; kind: string; product_key: string; make: string | null; model: string | null;
  format: string | null; chemistry: string | null; kwh_min: number | null; kwh_max: number | null;
  first_seen: string; last_seen: string; expires_on: string | null; quantity: number | null;
  quantity_unit: string | null; price: number | null; price_currency: string | null; price_unit: string | null;
  price_basis: string | null; price_max: number | null; decline_reason: string | null;
};

/** Every current line for some companies, read by company_id (index `buyer_interest_company_idx`). */
export const BUYER_LINES_SQL = `select company_id, kind, product_key, make, model, format, chemistry, kwh_min::float8 as kwh_min,
            kwh_max::float8 as kwh_max, first_seen::text, last_seen::text, expires_on::text, quantity::float8 as quantity,
            quantity_unit, price::float8 as price, price_currency, price_unit, price_basis,
            price_max::float8 as price_max, decline_reason
     from buyer_interest
     where company_id = any($1::text[]) and (expires_on is null or expires_on >= $2::date)`;

/** Every current line for these companies, one indexed read (company_id), grouped by company. */
export async function loadBuyerLines(companyIds: string[], asOf: string): Promise<Map<string, BuyerLine[]>> {
  const rows = companyIds.length ? await queryPg<LineRow>(BUYER_LINES_SQL, [companyIds, asOf]) : [];
  const lines = new Map<string, BuyerLine[]>();
  for (const row of rows) {
    const list = lines.get(row.company_id) ?? [];
    list.push({
      kind: row.kind, productKey: row.product_key, make: row.make, model: row.model, format: row.format,
      chemistry: row.chemistry, kwhMin: row.kwh_min, kwhMax: row.kwh_max, firstSeen: row.first_seen,
      lastSeen: row.last_seen, expiresOn: row.expires_on, quantity: row.quantity, quantityUnit: row.quantity_unit,
      price: row.price, priceCurrency: row.price_currency, priceUnit: row.price_unit,
      priceBasis: row.price_basis, priceMax: row.price_max, declineReason: row.decline_reason,
    });
    lines.set(row.company_id, list);
  }
  return lines;
}

/** The buyer pool: the buy box, or (with lines on) a current line of any kind but a decline. */
export function buyerPoolSql(withLines: boolean): string {
  const lineTest = withLines
    ? ` or exists (select 1 from buyer_interest i where i.company_id = c.id and i.kind <> 'declined'
                     and (i.expires_on is null or i.expires_on >= $2::date))`
    : "";
  return `select c.id, c.name, c.buyer_stage as stage, c.buyer_tier as tier, c.buyer_profile_basis as basis,
              c.buyer_profile as profile, c.buyer_profile -> 'dossier' as dossier
       from crm_companies c
       where (c.buyer_profile <> '{}'::jsonb${lineTest}) and c.buyer_exclusion_reason is null
         and coalesce(c.relationship_stage, '') <> 'Excluded'
         and ($1::text is null or c.id <> $1)`;
}

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

  const asOf = new Date().toISOString().slice(0, 10);
  const withLines = buyerLinesEnabled();
  const [demand, verdicts, companies] = await Promise.all([
    listDemand(),
    matchVerdicts(listingId),
    withLines
      ? queryPg<CompanyRow>(buyerPoolSql(true), [listing.company_id, asOf])
      : queryPg<CompanyRow>(buyerPoolSql(false), [listing.company_id]),
  ]);
  const lines = withLines ? await loadBuyerLines(companies.map((company) => company.id), asOf) : new Map<string, BuyerLine[]>();
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
      lines: withLines ? lines.get(company.id) ?? [] : null,
    }));
  const ranked = rankBuyers(supplies, buyers, {
    asOf, top: 30, verdicts: companyVerdicts, key,
  });

  const noGos = ranked.ruledOut.filter(isDossierNoGo).toSorted((a, b) => compareName(a.name, b.name));
  const shownNoGos = noGos.slice(0, RULED_OUT_CAP);
  // The main contact we can actually write to, so the offer carries a real address.
  const contacts = await queryPg<{ company_id: string; person_id: string; email: string | null }>(
    `select distinct on (p.company_id) p.company_id, p.id as person_id, p.email
     from crm_people p join crm_companies c on c.id = p.company_id
     where p.company_id = any($1::text[])
     order by p.company_id,
       (p.email is not null and not coalesce(p.email_opted_out, false)) desc,
       (p.id = c.buyer_main_contact_id) desc, p.full_name`,
    [[...ranked.ranked.map((row) => row.companyId), ...shownNoGos.map((row) => row.companyId)]],
  );
  const contactOf = new Map(contacts.map((row) => [row.company_id, row]));

  // A company with no product overlap at all is not a match; the tab shows the ones the key actually reached.
  for (const buyer of ranked.ranked.filter((row) => row.productTier > 0)) {
    rows.push(buyerRow(buyer, contactOf.get(buyer.companyId) ?? null, touch.get(buyer.companyId) ?? null, offers));
  }
  const listed = rows.map((row, index) => ({ ...row, rank: index + 1 }));
  // A dossier rule excludes a buyer from the ranking, never from sight. "Marked not a fit" stays hidden: that is our own call.
  const ruledOut = shownNoGos
    .map((row, index) => ruledOutRow(row, index + 1, asOf, contactOf.get(row.companyId) ?? null, touch.get(row.companyId) ?? null, offers));

  return {
    id: listingId,
    kind: "supply",
    lotKey,
    rows: listed,
    ruledOut,
    ruledOutTotal: noGos.length,
    considered: demand.length + ranked.evaluated,
    blocked: listed.length ? null : "Nothing fits yet. Add a dossier or a listing field to widen the match.",
    errors: [],
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

/** Only a dossier no-go reaches the list, each with its own text. A buy box mismatch or a kWh gap is not a refusal. */
export const RULED_OUT_CAP = 25;
export const isDossierNoGo = (row: RuledOutRow) => row.kind === "rule" && !!row.text;

const compareName = (a: string, b: string) => a.localeCompare(b, "en");

function ruledOutRow(
  rule: RuledOutRow, rank: number, asOf: string, contact: { person_id: string; email: string | null } | null,
  lastTouch: string | null, offers: Awaited<ReturnType<typeof offersForListing>>,
): MatchRow {
  const said = rule.seen ? shortDate(rule.seen, asOf) : null;
  const text = (rule.text ?? rule.detail).replace(/^./, (first) => first.toUpperCase());
  return {
    key: verdictKey.company(rule.companyId),
    rank,
    name: rule.name,
    detail: lastTouch ? `Last contact ${day(lastTouch)}` : "No contact yet",
    tags: [],
    reason: said ? `${text}, said ${said}` : text,
    checks: [],
    price: null,
    offer: offers.find(rule.companyId, contact?.person_id ?? null, rule.name),
    companyId: rule.companyId,
    personId: contact?.person_id ?? null,
    contact: contact?.email ?? null,
    stockId: null,
    ruledOut: { text, seen: rule.seen ?? null, source: rule.src ?? null },
  };
}
