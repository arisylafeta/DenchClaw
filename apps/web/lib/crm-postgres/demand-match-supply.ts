import "server-only";

// Loads our own inventory as demand-matching candidates: published marketplace sale listings, supplier stock-list
// rows, and live trades, auctions and supply batches. Read only. Marketplace reads are cached for five minutes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "../platform-admin/supabase";
import { queryPg } from "../postgres";
import { countryFromText, kwhFromText, sellerKey, type Candidate, type Format, type SourceKind } from "../demand-match";

const CACHE_MS = 5 * 60_000;
const SITE = "https://www.rebattery.io/marketplace/";

type ListingRow = {
  id: string; title: string; seo_slug: string | null; buy_now_price: number | null; currency: string | null;
  updated_at: string | null; published_at: string | null; visibility: string;
  accounts: { name: string | null } | null;
  listing_specs: SpecRow | SpecRow[] | null;
  listing_media: { count: number }[] | null;
};
type SpecRow = {
  chemistry: string | null; format: string | null; soh: number | null; quantity: number | null; quantity_available: number | null;
  pack_kwh: number | null; manufacturer: string | null; model: string | null; year_manufacture: number | null;
  location_address: { countryCode?: string; region?: string; city?: string; country?: string } | null;
  metadata_json: { partNumber?: string | null; cellFormat?: string | null } | null;
  test_data_json: Record<string, unknown> | null;
};

const FORMAT: Record<string, Format> = { pack: "Packs", module: "Modules", cell: "Cells", system: "Systems" };
const toFormat = (value: string | null | undefined): Format | null => {
  const key = value?.toLowerCase().replace(/s$/, "").trim() ?? "";
  return FORMAT[key] ?? (/bess|container|system/.test(key) ? "Systems" : null);
};

/** A single chemistry, or null when the row lists several candidates or none. */
function oneChemistry(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.toUpperCase().replace(/GENERIC_LI_ION|UNKNOWN|LI-ION|\|/g, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0] === "LIFEPO4" ? "LFP" : parts[0];
  return value.trim().toLowerCase() === "li-ion" ? "Li-ion" : null;
}

const hasTestData = (data: Record<string, unknown> | null) =>
  !!data && Object.values(data).some((v) => v !== null && v !== "" && !(typeof v === "object" && !Object.keys(v as object).length));

let listingCache: { at: number; rows: Promise<Candidate[]> } | null = null;

export function marketplaceCandidates(): Promise<Candidate[]> {
  if (!listingCache || Date.now() - listingCache.at > CACHE_MS) {
    const rows = (async () => {
      const db = getSupabaseAdminClient() as unknown as SupabaseClient;
      const out: Candidate[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db.from("listings")
          .select("id,title,seo_slug,buy_now_price,currency,updated_at,published_at,visibility,accounts!listings_supplier_account_id_fkey(name),listing_specs(chemistry,format,soh,quantity,quantity_available,pack_kwh,manufacturer,model,year_manufacture,location_address,metadata_json,test_data_json),listing_media(count)")
          .eq("listing_status", "published").eq("channel_mode", "sale").order("id").range(from, from + 999);
        if (error) throw new Error(`listings: ${error.message}`);
        const page = (data ?? []) as unknown as ListingRow[];
        out.push(...page.map(listingCandidate));
        if (page.length < 1000) return out;
      }
    })();
    listingCache = { at: Date.now(), rows };
    rows.catch(() => { if (listingCache?.rows === rows) listingCache = null; });
  }
  return listingCache.rows;
}

function listingCandidate(row: ListingRow): Candidate {
  const spec = Array.isArray(row.listing_specs) ? row.listing_specs[0] ?? null : row.listing_specs;
  const where = spec?.location_address;
  return {
    key: `listing:${row.id}`,
    source: "marketplace",
    title: row.title,
    seller: row.accounts?.name ?? null,
    make: spec?.manufacturer ?? null,
    model: spec?.model ?? null,
    format: toFormat(spec?.format),
    chemistry: oneChemistry(spec?.chemistry),
    cellFormat: spec?.metadata_json?.cellFormat ?? null,
    kwh: spec?.pack_kwh != null ? Number(spec.pack_kwh) : null,
    kwhEstimated: false,
    units: spec?.quantity_available ?? spec?.quantity ?? 1,
    price: row.buy_now_price != null ? Number(row.buy_now_price) : null,
    currency: row.currency,
    currencyAssumed: false,
    country: where?.countryCode ?? countryFromText(where?.country),
    location: [where?.region, where?.country].filter(Boolean).join(", ") || null,
    soh: spec?.soh != null ? Number(spec.soh) : null,
    year: spec?.year_manufacture ?? null,
    partNumber: spec?.metadata_json?.partNumber || null,
    photos: row.listing_media?.[0]?.count ?? 0,
    tested: hasTestData(spec?.test_data_json ?? null),
    verified: false,
    seen: row.updated_at ?? row.published_at,
    href: row.seo_slug ? `${SITE}${row.seo_slug}` : `${SITE}${row.id}`,
    ai: null,
    alsoIn: [],
  };
}

// Where a stock-list supplier is, from its location text, then its company suffix, then known UK suppliers.
const UK_SUPPLIERS = /synetiq|silverlake|asm|kore|scb|charles trent|aceon/i;
function supplierCountry(supplier: string, location: string | null, stated: string | null): string | null {
  if (stated && /^[A-Z]{2}$/.test(stated)) return stated;
  const fromText = countryFromText(location) ?? countryFromText(stated);
  if (fromText) return fromText;
  if (/didier/i.test(supplier)) return "BE";
  if (/\bAS\b/.test(supplier)) return "NO";
  if (/\bAB\b/.test(supplier)) return "SE";
  if (/B\.V\.|\bBV\b/.test(supplier)) return "NL";
  if (/\bUAB\b/.test(supplier)) return "LT";
  if (UK_SUPPLIERS.test(supplier)) return "GB";
  if (/norway|trøndelag|østfold|innlandet|romsdal/i.test(location ?? "")) return "NO";
  return null;
}
const COUNTRY_CURRENCY: Record<string, string> = { GB: "GBP", NO: "NOK", SE: "SEK", DK: "DKK", PL: "PLN", CH: "CHF", US: "USD", CN: "USD" };

type StockRow = {
  id: string; supplier: string; make: string | null; model: string | null; model_detail: string | null; year: string | null;
  part_number: string | null; description: string | null; quantity: number; price: number | null; location: string | null;
  chemistry: string | null; capacity_kwh: number | null; scope: string | null; soh_percent: number | null; tested: boolean | null;
  photo_urls: string[]; supplier_confirmed: boolean; updated_at: string; stock_status: string; attributes: Record<string, unknown>;
};

const SKIP_SCOPES = new Set(["obvious_nonpack", "spares", "inverter"]);

export async function stockCandidates(): Promise<Candidate[]> {
  const rows = await queryPg<StockRow>(
    `select id, supplier, make, model, model_detail, year, part_number, description, quantity::float8 as quantity,
       price::float8 as price, location, chemistry, capacity_kwh::float8 as capacity_kwh, scope, soh_percent::float8 as soh_percent,
       tested, photo_urls, supplier_confirmed, updated_at::text, stock_status, attributes
     from crm_stock_items where stock_status not in ('sold', 'unavailable')`,
  );
  return rows.filter((row) => !SKIP_SCOPES.has(row.scope ?? "")).map((row) => {
    const a = row.attributes ?? {};
    const str = (key: string) => (typeof a[key] === "string" && a[key] ? String(a[key]) : null);
    const country = supplierCountry(row.supplier, row.location, str("supplier_country"));
    const statedCurrency = str("price_currency") ?? str("currency");
    const kwhText = kwhFromText(`${row.model_detail ?? ""} ${row.description ?? ""}`);
    const kwh = row.capacity_kwh ?? (typeof a.energy_kwh === "number" ? a.energy_kwh : null)
      ?? (kwhText && "options" in kwhText && kwhText.options.length === 1 ? kwhText.options[0] : null);
    const scope = row.scope ?? "";
    const format: Format | null = /module/.test(scope) || str("category") === "modules" ? "Modules"
      : /cell/.test(scope) || str("category") === "cells" ? "Cells"
      : /bess|container/.test(scope) ? "Systems" : "Packs";
    return {
      key: `stock:${row.id}`,
      source: "stock" as SourceKind,
      title: [row.make, row.model, row.model_detail].filter(Boolean).join(" ") || row.description || row.part_number || "Stock row",
      seller: row.supplier,
      make: row.make,
      model: row.model,
      format,
      chemistry: oneChemistry(row.chemistry),
      cellFormat: str("cell_format"),
      kwh,
      kwhEstimated: false,
      units: row.quantity || 1,
      price: row.price,
      currency: statedCurrency ?? (country ? COUNTRY_CURRENCY[country] ?? "EUR" : null),
      currencyAssumed: !statedCurrency,
      country,
      location: row.location,
      soh: row.soh_percent,
      year: row.year && /^\d{4}/.test(row.year) ? Number(row.year.slice(0, 4)) : null,
      partNumber: row.part_number,
      photos: row.photo_urls?.length ?? 0,
      tested: !!row.tested,
      verified: row.supplier_confirmed,
      seen: row.updated_at,
      href: "/?path=stock",
      ai: null,
      alsoIn: [],
    };
  });
}

type FeedRow = { id: string; kind: "trade" | "auction" | "supply"; title: string; seller: string | null; size: string | null;
  location: string | null; seen: string | null; href: string; strength: "strong" | "partial" | null; reason: string | null };

/** Live trades, auctions and supply batches, with the inbox check's judgement for this demand where it made one. */
export async function feedCandidates(demandId: string): Promise<Candidate[]> {
  const rows = await queryPg<FeedRow>(
    `select feed.id, feed.kind, feed.title, feed.seller, feed.size, feed.location, feed.seen, feed.href,
       coalesce(dm.strength, sm.strength) as strength, coalesce(dm.reason, sm.reason) as reason
     from crm_bulk_trade_supply_feed feed
     left join crm_bulk_trade_demand_matches dm on dm.lot_id = feed.id and dm.demand_id = $1 and not dm.hidden and feed.kind <> 'supply'
     left join crm_bulk_trade_supply_matches sm on sm.supply_id = feed.id and sm.demand_id = $1 and not sm.hidden and feed.kind = 'supply'
     where feed.kind in ('trade', 'auction', 'supply')`,
    [demandId],
  );
  return rows.map((row) => {
    const kwhText = kwhFromText(row.title);
    // Size first ("680,000 cells"), else a title that starts with the count ("40 Toyota Proace 50 kWh packs").
    const unitWord = /(packs?|cells?|modules?|units?|containers?|systems?)\b/i;
    const sized = row.size?.replace(/,(\d{3})/g, "$1").match(/(\d+(?:\.\d+)?)\s*(packs?|cells?|modules?|units?|containers?|systems?)/i);
    const leading = row.title.replace(/,(\d{3})/g, "$1").match(/^(\d+)\s+\D/);
    const units = sized ?? (leading && unitWord.test(row.title) ? [leading[0], leading[1], row.title.match(unitWord)![1]] : null);
    return {
      key: `${row.kind === "supply" ? "supply" : "trade"}:${row.id}`,
      source: row.kind === "supply" ? "supply" : "trade",
      title: row.title,
      seller: row.seller,
      make: null,
      model: null,
      format: toFormat(units?.[2]) ?? (/\bcells?\b/i.test(row.title) ? "Cells" : /\bmodules?\b/i.test(row.title) ? "Modules"
        : /\b(bess|container|tender)\b/i.test(row.title) ? "Systems" : /\b(packs?|batteries)\b/i.test(row.title) ? "Packs" : null),
      chemistry: /\blfp\b/i.test(row.title) ? "LFP" : /\bnmc\b/i.test(row.title) ? "NMC" : null,
      cellFormat: null,
      kwh: kwhText && "options" in kwhText && kwhText.options.length === 1 ? kwhText.options[0] : null,
      kwhEstimated: false,
      units: units ? Number(units[1]) : null,
      price: null,
      currency: null,
      currencyAssumed: false,
      country: countryFromText(row.location),
      location: row.location,
      soh: null,
      year: null,
      partNumber: null,
      photos: 0,
      tested: false,
      verified: true,
      seen: row.seen,
      href: row.href,
      ai: row.strength ? { strength: row.strength, reason: row.reason ?? "" } : null,
      alsoIn: [],
    } satisfies Candidate;
  });
}

const supplierKey = sellerKey;
const pnKey = (pn: string | null) => (pn ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Joins the sources: a stock-list row that is also listed on the marketplace (same supplier and part number) is
 * shown once, as the listing; stock rows without kWh borrow it from listings of the same make and model when every
 * such listing agrees.
 */
export function mergeSources(listings: Candidate[], stock: Candidate[]): Candidate[] {
  const listed = new Map<string, Candidate[]>();
  for (const l of listings) {
    const pn = pnKey(l.partNumber);
    if (pn.length >= 6) listed.set(`${supplierKey(l.seller)}|${pn}`, [...(listed.get(`${supplierKey(l.seller)}|${pn}`) ?? []), l]);
  }
  const typical = new Map<string, Set<number>>();
  for (const l of listings) {
    if (!l.make || !l.model || !l.kwh) continue;
    const key = `${l.make.toLowerCase()}|${l.model.toLowerCase().split(/\s+/)[0]}`;
    typical.set(key, (typical.get(key) ?? new Set()).add(Math.round(l.kwh)));
  }
  const kept: Candidate[] = [];
  for (const s of stock) {
    const pn = pnKey(s.partNumber);
    const twins = pn.length >= 6 ? listed.get(`${supplierKey(s.seller)}|${pn}`) : undefined;
    const twin = twins?.find((t) => !t.alsoIn.includes("stock"));
    if (twin) {
      twin.alsoIn.push("stock");
      continue;
    }
    if (s.kwh == null && s.make && s.model) {
      const model = s.model.toLowerCase().replace(new RegExp(`^${s.make.toLowerCase()}\\s+`), "").split(/\s+/)[0];
      const sizes = typical.get(`${s.make.toLowerCase()}|${model}`);
      if (sizes?.size === 1) {
        s.kwh = [...sizes][0];
        s.kwhEstimated = true;
      }
    }
    kept.push(s);
  }
  return [...listings, ...kept];
}

/** Every candidate for one demand row, plus the units hidden as "Not a fit" for it. */
export type MatchVerdict = { verdict: "shortlist" | "not_a_fit"; at: string; note: string | null };

/** The latest Shortlist / Not a fit per unit, kept as Supply activity on the demand so it shows in the timeline. */
export async function matchVerdicts(demandId: string): Promise<Map<string, MatchVerdict>> {
  const rows = await queryPg<{ key: string; verdict: string; at: string; note: string | null }>(
    `select distinct on (data->'match'->>'key') data->'match'->>'key' as key, data->'match'->>'verdict' as verdict,
       occurred_at::text as at, body as note
     from crm_bulk_listing_activity
     where bulk_listing_id = $1 and kind = 'supply' and data ? 'match'
     order by data->'match'->>'key', occurred_at desc, id desc`,
    [demandId],
  );
  return new Map(rows.filter((r) => r.verdict === "shortlist" || r.verdict === "not_a_fit")
    .map((r) => [r.key, { verdict: r.verdict as MatchVerdict["verdict"], at: r.at, note: r.note }]));
}

export async function inventoryFor(demandId: string): Promise<{ candidates: Candidate[]; hidden: Set<string>; verdicts: Map<string, MatchVerdict>; errors: string[] }> {
  const errors: string[] = [];
  const [listings, stock, feed, hidden] = await Promise.all([
    marketplaceCandidates().catch((err) => { errors.push(`Marketplace: ${err instanceof Error ? err.message : err}`); return [] as Candidate[]; }),
    stockCandidates(),
    feedCandidates(demandId),
    matchVerdicts(demandId),
  ]);
  // Listings are cached and shared, so merge into copies.
  const copies = listings.map((l) => ({ ...l, alsoIn: [] as SourceKind[] }));
  const notFit = new Set([...hidden].filter(([, v]) => v.verdict === "not_a_fit").map(([key]) => key));
  return { candidates: [...feed, ...mergeSources(copies, stock)], hidden: notFit, verdicts: hidden, errors };
}
