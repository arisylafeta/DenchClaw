import "server-only";
import { readMailDraft } from "./crm-postgres/mail";
import { getDemand } from "./crm-postgres/bulk-demand";
import { stockCandidate, type StockRow } from "./crm-postgres/demand-matches-v2";
import { marketplaceCandidates } from "./crm-postgres/demand-match-supply";
import { cleanModel, normalMake } from "./commercial-stock";
import { parseLines } from "./demand-lines";
import { countryFromText, requirementFor, scoreCandidate, toEur, vocabulary, type Candidate } from "./demand-match";
import { editableCopy } from "./mail-draft-actions";
import type { MailDraft } from "./mail-types";
import { queryPg, withPgTransaction } from "./postgres";
import { readRelayItem, relayDraftForOwner, RelayError, type RelayItem } from "./relay";
import { ownText } from "./relay-context-core";
import { matchesQuery } from "./relay-desk-core";
import {
  alexFill, fitLabel, fitTier, isUk, MAX_FITS, shellOnly, mergeFills, missingFill, parseFills, pennyCardFor, priceFor, priceGaps, rankFits, readAsk, yearFrom,
  type Ask, type Fx, type PennyCard, type RankedFit,
} from "./relay-price-core";
import type { Money, PriceFill, StockFit } from "./relay-price-types";

/**
 * Relay's prices, the server part: the stock that fits a buyer's email, Relay's price for each, and the price fills
 * on a draft. Stock is read the way Matcha's Matches tab reads it (unlisted supplier stock in crm_stock_opportunities,
 * published marketplace listings from the platform), and judged by the same scorer. Read only, except for
 * relay_draft.fills. Nothing here writes to a draft's text or sends: sending fills the gaps (relay.ts withFills).
 */

/** Stock that fits, what Relay read from the email, and anything it could not read. */
export type StockReport = {
  fits: StockFit[];
  ask: { text: string; wants: string[]; delivered: boolean; ukDelivery: boolean; from: "email" | "deal" };
  /** Sources that could not be read, e.g. the marketplace. The fits are then from what could be. */
  errors: string[];
};

// ---------- reading stock ----------

type SupplyRow = StockRow & { list_price: number | null; list_currency: string | null; email: string | null; country_name: string | null };

const NUMBER = (path: string) => `case when jsonb_typeof(s.details->${path}) = 'number' then (s.details->${path})::text::numeric::float8
                 when (s.details->${path}) #>> '{}' ~ '^[0-9]+(\\.[0-9]+)?$' then ((s.details->${path}) #>> '{}')::numeric::float8 end`;

/**
 * Unlisted supplier stock, with the supplier's own price and currency (the price column) beside Matcha's euro figure.
 * Same lines as Matcha's unlistedStock: open opportunities not on a listing, not sold or gone, not marked undeliverable.
 * ids: only these lines (for a draft's price gaps).
 */
async function supplierStock(ids?: string[]): Promise<SupplyRow[]> {
  return queryPg<SupplyRow>(
    `select s.id, s.company_id, s.person_id, coalesce(c.name, p.full_name) as supplier, s.title,
            nullif(trim(s.details->>'make'), '') as make, s.details->>'model' as model, s.details->>'format' as format,
            s.details->>'chemistry' as chemistry, ${NUMBER("'capacity_kwh'")} as capacity_kwh, s.quantity::float8 as quantity,
            ${NUMBER("'quantity_available'")} as quantity_available,
            case s.details->'attributes'->>'quantity_stated' when 'false' then false when 'true' then true end as quantity_stated,
            case when jsonb_typeof(s.details->'price_eur') = 'number' then (s.details->'price_eur')::text::numeric::float8 end as price_eur,
            s.price::float8 as list_price, upper(nullif(trim(s.currency), '')) as list_currency,
            ${NUMBER("'soh_percent'")} as soh_percent,
            case when (s.details->>'year') ~ '^(19|20)[0-9]{2}$' then (s.details->>'year')::int end as year,
            case when jsonb_typeof(s.details->'part_numbers') = 'array' then array(select jsonb_array_elements_text(s.details->'part_numbers')) end as part_numbers,
            s.supplier_ref, s.description, s.source, s.details->'evidence'->>'source' as evidence_source, s.observed_on::text as observed_on, s.source_url,
            s.location, coalesce(nullif(c.country, ''), nullif(s.location, '')) as country, nullif(c.country, '') as country_name,
            lower(nullif(p.email, '')) as email,
            coalesce(s.details->'sync'->>'lastSeen', s.observed_on::text, s.updated_at::date::text) as seen_on
     from crm_stock_opportunities s
     left join crm_companies c on c.id = s.company_id
     left join crm_people p on p.id = s.person_id
     where s.status = 'opportunity'
       and s.marketplace_listing_id is null
       and s.bulk_listing_id is null
       and coalesce(s.details->>'deliver', 'true') <> 'false'
       and coalesce(s.details->'availability'->>'state', '') not in ('sold', 'not_found', 'gone')
       and ($1::text[] is null or s.id = any($1))
     order by s.updated_at desc`, [ids ?? null]);
}

const MONEY = new Set(["GBP", "EUR", "USD"]);

/** What the supplier wants, in a currency a price can be worked from: their own when it is GBP, EUR or USD, else Matcha's euros. */
function supplierCost(row: SupplyRow): Money | null {
  if (row.list_price != null && row.list_price > 0 && row.list_currency && MONEY.has(row.list_currency)) {
    return { amount: row.list_price, currency: row.list_currency as Money["currency"] };
  }
  return row.price_eur != null && row.price_eur > 0 ? { amount: Math.round(row.price_eur * 100) / 100, currency: "EUR" } : null;
}

function label(make: string | null, model: string | null, kwh: number | null, year: number | null, title: string): string {
  const shown = normalMake(make) ?? make;
  return fitLabel(shown, cleanModel(make, model) ?? model, kwh, year, title);
}

/** Where the stock is: the country its location names ("Shelford, United Kingdom"), else the supplier's. */
function stockCountry(location: string | null, companyCountry: string | null): string | null {
  const last = location?.split(",").at(-1)?.trim() ?? "";
  return last && countryFromText(last) ? last : companyCountry;
}

function supplierFit(row: SupplyRow): StockFit {
  const year = yearFrom(row.year, row.title);
  return {
    key: `stock:${row.id}`, label: label(row.make, row.model, row.capacity_kwh, year, row.title), kind: "supplier",
    supplier: { name: row.supplier ?? "Unknown supplier", country: stockCountry(row.location, row.country_name), email: row.email },
    kwh: row.capacity_kwh, year, soh: row.soh_percent, cost: supplierCost(row), listed: null, href: `/trades/stock/${row.id}`,
  };
}

/** A published listing with a price, as a fit. The listing's own price already holds our commission. */
function marketFit(c: Candidate): StockFit | null {
  const currency = c.currency?.toUpperCase() ?? "";
  if (c.price == null || !(c.price > 0) || !MONEY.has(currency)) return null;
  return {
    key: `market:${c.key.replace(/^listing:/, "")}`, label: label(c.make, c.model, c.kwh, c.year, c.title), kind: "marketplace",
    supplier: { name: c.seller ?? "Marketplace seller", country: c.country, email: null },
    kwh: c.kwh, year: c.year, soh: c.soh, cost: null, listed: { amount: c.price, currency: currency as Money["currency"] }, href: c.href,
  };
}

type MirrorRow = { listing_id: string; title: string; supplier: string | null; make: string | null; model: string | null; kwh: number | null; price: number; currency: string; year: number | null; soh: number | null; country: string | null; location: string | null; slug: string | null };

/**
 * The CRM's copy of published marketplace listings (stock lines the platform sync marked published, with the listed
 * price). Used only when the platform cannot be read, and said so in the report's errors.
 */
async function marketplaceMirror(listingIds?: string[]): Promise<Candidate[]> {
  const rows = await queryPg<MirrorRow>(
    `select s.marketplace_listing_id as listing_id, s.title, coalesce(c.name, p.full_name) as supplier, nullif(trim(s.details->>'make'), '') as make,
            s.details->>'model' as model, ${NUMBER("'capacity_kwh'")} as kwh, s.price::float8 as price, upper(s.currency) as currency,
            case when (s.details->>'year') ~ '^(19|20)[0-9]{2}$' then (s.details->>'year')::int end as year, ${NUMBER("'soh_percent'")} as soh,
            nullif(c.country, '') as country, s.location, s.details->'marketplace'->>'slug' as slug
     from crm_stock_opportunities s left join crm_companies c on c.id = s.company_id left join crm_people p on p.id = s.person_id
     where s.status = 'listed' and s.marketplace_status = 'published' and s.price > 0
       and ($1::text[] is null or s.marketplace_listing_id = any($1))`, [listingIds ?? null]);
  return rows.map((r) => ({
    key: `listing:${r.listing_id}`, source: "marketplace", title: r.title, seller: r.supplier, make: r.make, model: r.model, format: "Packs",
    chemistry: null, cellFormat: null, kwh: r.kwh, kwhEstimated: false, units: 1, unitsBare: true, price: r.price, currency: r.currency,
    currencyAssumed: false, country: stockCountry(r.location, r.country), location: r.location, soh: r.soh, year: yearFrom(r.year, r.title), partNumber: null, photos: 0,
    tested: false, verified: false, seen: null, sourceKind: "marketplace listing",
    href: `https://www.rebattery.io/marketplace/${r.slug ?? r.listing_id}`, ai: null, alsoIn: [],
  }));
}

/** Published marketplace listings, from the platform (cached for five minutes by Matcha's reader), else the CRM's copy. */
async function marketplace(errors: string[], listingIds?: string[]): Promise<Candidate[]> {
  try {
    const all = await marketplaceCandidates();
    return listingIds ? all.filter((c) => listingIds.includes(c.key.replace(/^listing:/, ""))) : all;
  } catch (error) {
    errors.push(`Marketplace: ${error instanceof Error ? error.message : String(error)}. Used the CRM's copy of published listings instead.`);
    return marketplaceMirror(listingIds);
  }
}

// ---------- reading the ask ----------

/** Their newest emails on the thread, in their own words (quotes and signatures' replies cut), newest first. */
async function theirWords(item: RelayItem): Promise<string[]> {
  const rows = item.mail_thread_id ? await queryPg<{ subject: string | null; body_text: string | null }>(
    `select subject, left(body_text, 6000) as body_text from mail_message
     where thread_id = $1 and direction = 'inbound' and state in ('received','accepted','sent','delivered','opened','clicked','replied')
     order by coalesce(sent_at, accepted_at, created_at) desc limit 2`, [item.mail_thread_id]) : [];
  const words = rows.map((r) => ownText(r.body_text ?? "", r.subject)).filter(Boolean);
  if (!words.length && item.last_message?.text) words.push(item.last_message.text);
  return [...words, item.headline];
}

/** The ask: Matcha's own requirement and pack types when the email is linked to a request, else read from the email. */
async function askFor(item: RelayItem, vocab: Set<string>): Promise<{ ask: Ask; from: "email" | "deal" }> {
  const fromEmail = readAsk(await theirWords(item), vocab);
  const demand = item.bulk_listing_id ? await getDemand(item.bulk_listing_id) : null;
  if (!demand) return { ask: fromEmail, from: "email" };
  const lines = parseLines(demand.context?.lines ?? []);
  return {
    ask: { ...fromEmail, requirement: requirementFor(demand, vocab), lines: "value" in lines && lines.value.length ? lines.value : fromEmail.lines },
    from: "deal",
  };
}

// ---------- prices ----------

const FX_CACHE_MS = 10 * 60_000;
/**
 * Used only when no stock line carries an ECB reference rate. From the newest GBP and USD stock lines on 20 Nov 2026
 * (details.fx: £0.83595 per € on 12 Nov, $1.1188 per € on 26 Oct). It goes stale like any rate and is warned about.
 */
export const FX_FALLBACK: Fx = { gbpPerEur: 0.83595, gbpPerUsd: 0.83595 / 1.1188, date: "2026-11-12", source: "ECB reference, kept in code" };
let fxCache: { at: number; fx: Promise<Fx> } | null = null;

/**
 * The exchange rate Relay prices with: the newest ECB reference rate the stock sync stored on a GBP (and USD) stock
 * line (details.fx: that currency per euro, dated). FX_FALLBACK when there is none.
 */
export function fxNow(): Promise<Fx> {
  if (!fxCache || Date.now() - fxCache.at > FX_CACHE_MS) {
    const fx = (async () => {
      const rows = await queryPg<{ currency: string; rate: number; date: string }>(
        `select distinct on (currency) currency, (details->'fx'->>'rate')::float8 as rate, details->'fx'->>'date' as date
         from crm_stock_opportunities
         where currency in ('GBP','USD') and details->'fx'->>'source' = 'ECB reference'
           and details->'fx'->>'rate' ~ '^[0-9]+(\\.[0-9]+)?$' and details->'fx'->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         order by currency, details->'fx'->>'date' desc`);
      const gbp = rows.find((r) => r.currency === "GBP");
      const usd = rows.find((r) => r.currency === "USD");
      if (!gbp || !(gbp.rate > 0)) return FX_FALLBACK;
      return { gbpPerEur: gbp.rate, gbpPerUsd: usd && usd.rate > 0 ? gbp.rate / usd.rate : null, date: gbp.date, source: "ECB reference" };
    })();
    fxCache = { at: Date.now(), fx };
    fx.catch(() => { if (fxCache?.fx === fx) fxCache = null; });
  }
  return fxCache.fx;
}

/** The latest Penny card per battery. */
export function pennyCards(): Promise<PennyCard[]> {
  return queryPg<PennyCard>(
    `select distinct on (battery_key) battery_key, battery, segment, kwh_usable::float8 as kwh_usable, quick_gbp_kwh::float8 as quick_gbp_kwh,
       expected_gbp_kwh::float8 as expected_gbp_kwh, patient_gbp_kwh::float8 as patient_gbp_kwh, confidence, created_at::text as created_at
     from crm_price_cards order by battery_key, created_at desc`);
}

/** Relay's price for each fit, in the same order: the current exchange rate and each battery's Penny card. */
export async function priceStock(fits: StockFit[], { askedDelivered, now = new Date() }: { askedDelivered: boolean; now?: Date }): Promise<PriceFill[]> {
  if (!fits.length) return [];
  const [fx, cards] = await Promise.all([fxNow(), pennyCards()]);
  return fits.map((fit) => priceFor(fit, { penny: pennyCardFor(fit, cards), fx, now, askedDelivered }));
}

// ---------- stock that fits ----------

/**
 * The stock that fits what an email asks for, best first, at most MAX_FITS, with what Relay read and any source it
 * could not read. Judged by Matcha's scorer (scoreCandidate); ranked by the buyer's pack types (lineFor, 5% kWh
 * tolerance), Matcha's verdict, a price to quote, then newer or cheaper. One per supplier comes first.
 */
export async function stockReport(itemId: string, ownerId: string, { limit = MAX_FITS }: { limit?: number } = {}): Promise<StockReport> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  const errors: string[] = [];
  const [rows, listings] = await Promise.all([supplierStock(), marketplace(errors)]);
  const supply = rows.map((row) => ({ row, candidate: stockCandidate(row) }));
  const { ask, from } = await askFor(item, vocabulary([...listings, ...supply.map((s) => s.candidate)]));
  const wants = ask.requirement.pinned;
  if (!wants.length && !ask.listings.length) return { fits: [], ask: { text: ask.text, wants, delivered: ask.delivered, ukDelivery: ask.ukDelivery, from }, errors };

  const ranked: RankedFit[] = [];
  const consider = (candidate: Candidate, fit: StockFit | null) => {
    if (!fit || shellOnly(candidate.title, ask)) return;
    // A listing the email links to is what they asked about, whatever the scorer makes of their words.
    const named = fit.kind === "marketplace" && !!fit.href && ask.listings.some((slug) => fit.href!.toLowerCase().endsWith(`/${slug}`));
    const match = scoreCandidate(ask.requirement, candidate);
    if (!match && !named) return;
    const money = fit.cost ?? fit.listed;
    const eur = money ? toEur(money.amount, money.currency) : null;
    ranked.push({
      fit, named, exact: match?.verdict === "exact", roughGbp: eur == null ? null : eur / (toEur(1, "GBP") ?? 1),
      uk: isUk(fit.supplier.country),
      tier: fitTier(ask.lines, { make: candidate.make, model: candidate.model, title: candidate.title, kwh: candidate.kwh, kwhEstimated: candidate.kwhEstimated }),
    });
  };
  // A stock line with no make is judged only when a code in the ask names it, as on Matcha's Matches tab.
  for (const { row, candidate } of supply) if (candidate.make) consider(candidate, supplierFit(row));
  for (const listing of listings) consider(listing, marketFit(listing));
  return { fits: rankFits(ranked, { recent: ask.recent, uk: ask.ukDelivery }, limit), ask: { text: ask.text, wants, delivered: ask.delivered, ukDelivery: ask.ukDelivery, from }, errors };
}

/**
 * The stock that fits what an email asks for, best first, at most about six (see stockReport for the errors and what
 * was read). For the chat: price them with priceStock, and put a price in a draft as priceGapMarker(fit).
 */
export async function stockFits(itemId: string, ownerId: string): Promise<StockFit[]> {
  return (await stockReport(itemId, ownerId)).fits;
}

/** The fits for these keys, wherever they still are (stock that went is missing from the map). */
async function fitsByKey(keys: string[], errors: string[]): Promise<Map<string, StockFit>> {
  const stockIds = keys.filter((k) => k.startsWith("stock:")).map((k) => k.slice("stock:".length));
  const listingIds = keys.filter((k) => k.startsWith("market:")).map((k) => k.slice("market:".length));
  const [rows, listings] = await Promise.all([
    stockIds.length ? supplierStock(stockIds) : Promise.resolve([]),
    listingIds.length ? marketplace(errors, listingIds) : Promise.resolve([]),
  ]);
  const fits = [...rows.map(supplierFit), ...listings.map(marketFit)].filter((f): f is StockFit => !!f);
  return new Map(fits.map((f) => [f.key, f]));
}

// ---------- fills on a draft ----------

/** A Relay draft Alex can still change: its row, its mail and the price gaps in its text. */
async function openDraft(draftId: string, ownerId: string): Promise<{ itemId: string; mail: MailDraft; body: string; gaps: { key: string; label: string }[] }> {
  const draft = await relayDraftForOwner(draftId, ownerId);
  if (!draft?.mail_message_id) throw new RelayError(404, "Not found");
  const mail = await readMailDraft(draft.mail_message_id, ownerId);
  if (!mail) throw new RelayError(404, "Not found");
  if (mail.state !== "draft") throw new RelayError(409, "This email was already sent.");
  const [held] = await queryPg<{ id: string }>("select id from mail_message where id = $1 and personalization ? 'scheduled_send'", [mail.id]);
  if (held) throw new RelayError(409, "This email is set to send. Undo or cancel that first.");
  const body = (await editableCopy(mail)).main;
  return { itemId: draft.item_id, mail, body, gaps: priceGaps(body) };
}

/** Changes a draft's fills under a row lock, so Relay's re-price and Alex's change cannot overwrite each other. */
async function changeFills(draftId: string, change: (current: PriceFill[]) => PriceFill[]): Promise<PriceFill[]> {
  return withPgTransaction(async (tx) => {
    const { rows } = await tx.query<{ fills: unknown }>("select fills from relay_draft where id = $1 for update", [draftId]);
    if (!rows.length) throw new RelayError(404, "Not found");
    const next = change(parseFills(rows[0].fills));
    await tx.query("update relay_draft set fills = $2::jsonb where id = $1", [draftId, JSON.stringify(next)]);
    return next;
  });
}

/**
 * Works out a price for every price gap in the draft ([BLANK: price for <label> (ref <key>)]) and stores them as the
 * draft's fills. A fill Alex set or accepted is kept as it is. A gap whose stock went gets an empty fill saying so.
 * Returns the fills. Never changes the draft's text: the prices go in when Alex sends or copies it to Gmail.
 */
export async function priceDraft(draftId: string, ownerId: string, now = new Date()): Promise<PriceFill[]> {
  const { itemId, gaps } = await openDraft(draftId, ownerId);
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  const delivered = readAsk(await theirWords(item), new Set()).delivered;
  const errors: string[] = [];
  const fits = await fitsByKey(gaps.map((g) => g.key), errors);
  if (errors.length) console.warn("relay price", errors.join(" "));
  const priced = await priceStock([...fits.values()], { askedDelivered: delivered, now });
  const fresh = gaps.map((gap) => priced.find((p) => p.key === gap.key) ?? missingFill(gap.key, gap.label, delivered));
  return changeFills(draftId, (current) => mergeFills(current, fresh));
}

/**
 * Alex's price for one gap (whole pounds), or null to clear it and leave the gap open. Marks the fill his. by "relay":
 * the desk set it in the chat, so it stays Relay's (yellow) until Alex accepts or changes it, and a re-price may replace it.
 */
export async function setFill(draftId: string, ownerId: string, key: string, value: number | null, by: PriceFill["by"] = "alex"): Promise<PriceFill[]> {
  const { gaps } = await openDraft(draftId, ownerId);
  return changeFills(draftId, (current) => {
    const gap = gaps.find((g) => g.key === key);
    if (!gap) throw new RelayError(404, "That price is no longer in the draft.");
    const known = current.find((f) => f.key === key);
    // A gap Relay has not priced yet takes Alex's price with nothing worked out beside it.
    const base = known ?? { ...missingFill(key, gap.label, false), working: [by === "alex" ? "Alex's price." : "Relay's price, set in the chat."] };
    const mine = alexFill(by === "relay" && known ? { ...base, working: [...base.working, "Changed by Relay in the chat."] } : base, value);
    const fill = { ...mine, by };
    return known ? current.map((f) => (f.key === key ? fill : f)) : [...current, fill];
  });
}

/** The price gaps in a draft that can still be changed, for the desk's dry run: what setFill would check, without writing. */
export async function draftPriceGaps(draftId: string, ownerId: string): Promise<{ key: string; label: string }[]> {
  return (await openDraft(draftId, ownerId)).gaps;
}

/** Published marketplace listings whose title has every word of the query, newest reader first (the desk's marketplace_listings). */
export async function marketplaceListings(query: string, limit: number): Promise<{ listings: Candidate[]; errors: string[] }> {
  const errors: string[] = [];
  const hit = (await marketplace(errors)).filter((c) => matchesQuery(`${c.title} ${c.make ?? ""} ${c.model ?? ""}`, query));
  return { listings: hit.slice(0, limit), errors };
}

/** Alex accepts Relay's price for one gap as it is: the fill becomes his, so a re-price leaves it. */
export async function acceptFill(draftId: string, ownerId: string, key: string): Promise<PriceFill[]> {
  const { gaps } = await openDraft(draftId, ownerId);
  return changeFills(draftId, (current) => {
    const fill = current.find((f) => f.key === key);
    if (!fill || !gaps.some((g) => g.key === key)) throw new RelayError(404, "That price is no longer in the draft.");
    if (fill.value == null) throw new RelayError(409, "There's no price to accept yet. Type one in.");
    return current.map((f) => (f.key === key ? { ...f, by: "alex" } : f));
  });
}
