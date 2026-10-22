import "server-only";

// Loads our own inventory as demand-matching candidates: published marketplace sale listings and live trades,
// auctions and supply batches. Read only. Marketplace reads are cached for five minutes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "../platform-admin/supabase";
import { queryPg } from "../postgres";
import { countryFromText, kwhFromText, type Candidate, type Format, type SourceKind } from "../demand-match";

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

type FeedRow = { id: string; kind: "trade" | "auction" | "supply"; title: string; seller: string | null; size: string | null;
  location: string | null; seen: string | null; href: string; strength: "strong" | "partial" | null; reason: string | null };

/** Live trades, auctions and supply batches, with the inbox check's judgement for this demand where it made one. */
export async function feedCandidates(demandId: string): Promise<Candidate[]> {
  const rows = await queryPg<FeedRow>(
    `select feed.id, feed.kind, feed.title, feed.seller, feed.size, feed.location, feed.seen, feed.href,
       coalesce(dm.strength, sm.strength) as strength, coalesce(dm.reason, sm.reason) as reason
     from crm_bulk_listing_supply_feed feed
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
  const [listings, feed, hidden] = await Promise.all([
    marketplaceCandidates().catch((err) => { errors.push(`Marketplace: ${err instanceof Error ? err.message : err}`); return [] as Candidate[]; }),
    feedCandidates(demandId),
    matchVerdicts(demandId),
  ]);
  // Listings are cached and shared, so merge into copies.
  const copies = listings.map((l) => ({ ...l, alsoIn: [] as SourceKind[] }));
  const notFit = new Set([...hidden].filter(([, v]) => v.verdict === "not_a_fit").map(([key]) => key));
  return { candidates: [...feed, ...copies], hidden: notFit, verdicts: hidden, errors };
}
