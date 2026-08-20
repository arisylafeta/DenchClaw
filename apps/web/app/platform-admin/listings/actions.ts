"use server";

import { unstable_noStore as noStore } from "next/cache";

import type { Database, Json } from "@/lib/platform-admin/database.types";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  normalizeListingFilters,
  type ListingDetail,
  type ListingConversationActivity,
  type ListingEvidence,
  type ListingOfferActivity,
  type ListingOpportunityLink,
  type ListingListRow,
  type ListingOutboundContext,
  type ListingPage,
  type ListingPageInput,
  type ListingProvenance,
  type ListingSort,
} from "./contract";

const PAGE_SIZE = 25;
const MAX_PAGE = 10_000;
const MAX_SEARCH_MATCHES = 250;

type MarketplaceRow = Database["public"]["Views"]["listings_marketplace_v"]["Row"];
type MarketplaceRuntimeRow = MarketplaceRow & {
  location_address?: Json | null;
  filter_location_country?: string | null;
};
type ListingRow = Pick<
  Database["public"]["Tables"]["listings"]["Row"],
  | "id"
  | "title"
  | "reference"
  | "seo_slug"
  | "supplier_account_id"
  | "created_by_user_id"
  | "channel_mode"
  | "listing_status"
  | "visibility"
  | "description"
  | "created_at"
  | "updated_at"
>;
type ListingSpecsRow = Database["public"]["Tables"]["listing_specs"]["Row"];
type AccountRow = Pick<Database["public"]["Tables"]["accounts"]["Row"], "id" | "name" | "role" | "sector">;
type ActivityCountRow = { listing_id: string; enquiry_count: number | null; deal_count: number | null };
type ConversationActivityRow = Pick<
  Database["public"]["Tables"]["conversations"]["Row"],
  "id" | "status" | "last_message_at" | "last_message_preview"
>;
type PurchaseOfferActivityRow = Pick<
  Database["public"]["Tables"]["purchase_offers"]["Row"],
  "id" | "status" | "buyer_account_id" | "quantity_requested" | "submitted_at"
>;
type RecyclingOfferActivityRow = Pick<
  Database["public"]["Tables"]["recycling_offers"]["Row"],
  "id" | "status" | "recycler_account_id" | "submitted_at"
>;
type OpportunityLinkRow = Pick<
  Database["public"]["Tables"]["recycler_opportunity_links"]["Row"],
  "id" | "link_type" | "state" | "recycler_account_id" | "created_at" | "updated_at" | "expires_at"
>;

type ReadResult = {
  data: unknown;
  error: { message: string } | null;
  count?: number | null;
};

const LISTING_COLUMNS = [
  "id",
  "title",
  "listing_status",
  "visibility",
  "channel_mode",
  "supplier_account_id",
  "supplier_display_name",
  "pack_kwh",
  "pack_weight_kg",
  "quantity",
  "chemistry",
  "location_address",
  "filter_location_country",
  "seo_slug",
  "created_at",
  "updated_at",
].join(", ");

const SORT_COLUMNS: Record<ListingSort, { column: string; ascending: boolean }> = {
  updated_desc: { column: "updated_at", ascending: false },
  updated_asc: { column: "updated_at", ascending: true },
  capacity_desc: { column: "pack_kwh", ascending: false },
  capacity_asc: { column: "pack_kwh", ascending: true },
  weight_desc: { column: "pack_weight_kg", ascending: false },
  weight_asc: { column: "pack_weight_kg", ascending: true },
};

function safePage(value: unknown): number {
  const page = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(page)) { return 1; }
  return Math.min(MAX_PAGE, Math.max(1, Math.floor(page)));
}

function cleanSearch(value: string): string {
  return value.replace(/[(),*%_"'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value);
}

function throwReadError(): never {
  throw new Error("Unable to load marketplace listings");
}

async function readRows<T>(result: PromiseLike<ReadResult>): Promise<T[]> {
  const response = await result;
  if (response.error) { throwReadError(); }
  return Array.isArray(response.data) ? response.data as T[] : [];
}

async function readOne<T>(result: PromiseLike<ReadResult>): Promise<T | null> {
  const response = await result;
  if (response.error) { throwReadError(); }
  return response.data ? response.data as T : null;
}

async function readOptionalRows<T>(factory: () => PromiseLike<ReadResult>): Promise<T[]> {
  try {
    return await readRows<T>(factory());
  } catch {
    return [];
  }
}

async function readOptionalCount(factory: () => PromiseLike<ReadResult>): Promise<number> {
  try {
    const response = await factory();
    if (response.error) { return 0; }
    return typeof response.count === "number"
      ? response.count
      : Array.isArray(response.data) ? response.data.length : 0;
  } catch {
    return 0;
  }
}

function uniqueIds(rows: Array<{ id?: string | null; listing_id?: string | null }>): string[] {
  return [...new Set(rows.flatMap((row) => {
    const id = row.id ?? row.listing_id;
    return typeof id === "string" && id ? [id] : [];
  }))].slice(0, MAX_SEARCH_MATCHES);
}

async function resolveSearchListingIds(
  supabase: ReturnType<typeof getSupabaseAdminClient>,
  rawSearch: string,
): Promise<string[]> {
  const search = cleanSearch(rawSearch);
  if (!search) { return []; }
  const pattern = `%${search}%`;

  const [marketplaceRows, listingRows, specsRows] = await Promise.all([
    readRows<{ id: string | null }>(
      supabase
        .from("listings_marketplace_v")
        .select("id")
        .or([
          `title.ilike.${pattern}`,
          `supplier_display_name.ilike.${pattern}`,
          `chemistry.ilike.${pattern}`,
          `filter_location_country.ilike.${pattern}`,
        ].join(","))
        .limit(MAX_SEARCH_MATCHES),
    ),
    readRows<{ id: string }>(
      supabase
        .from("listings")
        .select("id")
        .or(`title.ilike.${pattern},reference.ilike.${pattern},seo_slug.ilike.${pattern}`)
        .limit(MAX_SEARCH_MATCHES),
    ),
    readRows<{ listing_id: string }>(
      supabase
        .from("listing_specs")
        .select("listing_id")
        .or([
          `manufacturer.ilike.${pattern}`,
          `model.ilike.${pattern}`,
          `format.ilike.${pattern}`,
          `location_address->>city.ilike.${pattern}`,
          `location_address->>region.ilike.${pattern}`,
          `location_address->>country.ilike.${pattern}`,
          `location_address->>countryCode.ilike.${pattern}`,
        ].join(","))
        .limit(MAX_SEARCH_MATCHES),
    ),
  ]);

  const directListingRows = isUuid(search)
    ? await readRows<{ id: string }>(
        supabase.from("listings").select("id").eq("id", search).limit(1),
      )
    : [];

  return uniqueIds([...marketplaceRows, ...listingRows, ...specsRows, ...directListingRows]);
}

type LocationFields = {
  city: string | null;
  region: string | null;
  country: string | null;
};

function parseLocation(address: Json | null | undefined, fallbackCountry: string | null = null): LocationFields {
  if (!address || typeof address !== "object" || Array.isArray(address)) {
    return { city: null, region: null, country: fallbackCountry };
  }
  const value = address as Record<string, Json | undefined>;
  const read = (key: string): string | null => typeof value[key] === "string" ? value[key] as string : null;
  return {
    city: read("city"),
    region: read("region"),
    country: read("country") ?? read("countryCode") ?? fallbackCountry,
  };
}

function hasEvidence(value: unknown): boolean {
  if (typeof value === "number") { return Number.isFinite(value); }
  if (typeof value === "string") { return value.trim().length > 0; }
  if (Array.isArray(value)) { return value.length > 0; }
  return Boolean(value && typeof value === "object");
}

function buildEvidence(
  listing: ListingRow,
  specs: ListingSpecsRow | null,
  location: LocationFields,
): ListingEvidence {
  const fields: Array<[string, unknown]> = [
    ["Title", listing.title],
    ["Manufacturer", specs?.manufacturer],
    ["Model", specs?.model],
    ["Chemistry", specs?.chemistry],
    ["Pack capacity", specs?.pack_kwh],
    ["Pack weight", specs?.pack_weight_kg],
    ["Quantity", specs?.quantity],
    ["Location", [location.city, location.region, location.country].filter(Boolean).join(", ")],
    ["Description", listing.description],
  ];
  const missing = fields.filter(([, value]) => !hasEvidence(value)).map(([label]) => label);
  return { present: fields.length - missing.length, total: fields.length, missing };
}

function metadataString(metadata: Json, keys: string[]): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) { return null; }
  const record = metadata as Record<string, Json | undefined>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) { return value.trim().slice(0, 500); }
  }
  return null;
}

function buildProvenance(listing: ListingRow, specs: ListingSpecsRow | null): ListingProvenance {
  const metadata = specs?.metadata_json ?? {};
  return {
    createdByUserId: listing.created_by_user_id ?? null,
    sourceLabel: metadataString(metadata, ["source", "source_name", "source_type", "origin", "generated_by", "generator"]),
    sourceUrl: metadataString(metadata, ["source_url", "sourceUrl", "url", "listing_url"]),
    metadata,
  };
}

function accountSegment(account: AccountRow | undefined): string | null {
  if (!account) { return null; }
  const parts = [account.role, account.sector].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ").replaceAll("_", " ") : null;
}

function buildOutboundContext(
  listing: ListingRow,
  activity: ActivityCountRow | undefined,
  purchaseOffers: PurchaseOfferActivityRow[],
  recyclingOffers: RecyclingOfferActivityRow[],
  purchaseOfferCount: number,
  recyclingOfferCount: number,
  opportunityLinks: OpportunityLinkRow[],
  opportunityCount: number,
  conversations: ConversationActivityRow[],
  conversationCount: number,
  accountsById: Map<string, AccountRow>,
): ListingOutboundContext {
  const recentOffers: ListingOfferActivity[] = [
    ...purchaseOffers.map((offer) => {
      const account = accountsById.get(offer.buyer_account_id);
      return {
        id: offer.id,
        kind: "purchase" as const,
        status: offer.status,
        counterpartName: account?.name ?? null,
        counterpartRole: account?.role ?? null,
        counterpartSector: account?.sector ?? null,
        quantityRequested: offer.quantity_requested,
        submittedAt: offer.submitted_at,
      };
    }),
    ...recyclingOffers.map((offer) => {
      const account = accountsById.get(offer.recycler_account_id);
      return {
        id: offer.id,
        kind: "recycling" as const,
        status: offer.status,
        counterpartName: account?.name ?? null,
        counterpartRole: account?.role ?? null,
        counterpartSector: account?.sector ?? null,
        quantityRequested: null,
        submittedAt: offer.submitted_at,
      };
    }),
  ].toSorted((left, right) => (right.submittedAt ?? "").localeCompare(left.submittedAt ?? ""));

  const links: ListingOpportunityLink[] = opportunityLinks.map((link) => {
    const account = accountsById.get(link.recycler_account_id);
    return {
      id: link.id,
      linkType: link.link_type,
      state: link.state,
      accountName: account?.name ?? null,
      accountRole: account?.role ?? null,
      accountSector: account?.sector ?? null,
      createdAt: link.created_at,
      updatedAt: link.updated_at,
      expiresAt: link.expires_at,
    };
  });

  const buyerSegments = [...new Set([
    ...purchaseOffers.map((offer) => accountSegment(accountsById.get(offer.buyer_account_id))),
    ...recyclingOffers.map((offer) => accountSegment(accountsById.get(offer.recycler_account_id))),
    ...opportunityLinks.map((link) => accountSegment(accountsById.get(link.recycler_account_id))),
  ].filter((segment): segment is string => Boolean(segment)))];

  return {
    targetStatus: null,
    currentAvailability: listing.listing_status,
    buyerSegments,
    enquiryCount: Number(activity?.enquiry_count ?? 0),
    dealCount: Number(activity?.deal_count ?? 0),
    offerCount: purchaseOfferCount + recyclingOfferCount,
    opportunityCount,
    conversationCount,
    lastMarketplaceContactAt: conversations[0]?.last_message_at ?? null,
    recentOffers: recentOffers.slice(0, MAX_ACTIVITY_ITEMS),
    opportunityLinks: links.slice(0, MAX_ACTIVITY_ITEMS),
    conversations: conversations.slice(0, MAX_ACTIVITY_ITEMS).map((conversation) => ({
      id: conversation.id,
      status: conversation.status,
      lastMessageAt: conversation.last_message_at,
      lastMessagePreview: conversation.last_message_preview,
    } satisfies ListingConversationActivity)),
  };
}

const MAX_ACTIVITY_ITEMS = 5;

function mapListRow(
  row: MarketplaceRuntimeRow,
  referenceById: Map<string, { reference: string | null; seo_slug: string | null }>,
): ListingListRow | null {
  if (!row.id) { return null; }
  const listing = referenceById.get(row.id);
  const location = parseLocation(row.location_address, row.filter_location_country);
  return {
    id: row.id,
    title: row.title,
    reference: listing?.reference ?? null,
    seoSlug: listing?.seo_slug ?? row.seo_slug,
    supplierAccountId: row.supplier_account_id,
    supplierName: row.supplier_display_name,
    status: row.listing_status,
    channel: row.channel_mode,
    visibility: row.visibility,
    quantity: row.quantity,
    packKwh: row.pack_kwh,
    packWeightKg: row.pack_weight_kg,
    chemistry: row.chemistry,
    locationCity: location.city ?? row.location_city,
    locationRegion: location.region ?? row.location_region,
    locationCountry: location.country ?? row.location_country,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export async function getListingPage(input: ListingPageInput = {}): Promise<ListingPage> {
  noStore();
  const filters = normalizeListingFilters(input);
  const snapshotAt = new Date().toISOString();
  const page = safePage(input.page);
  const supabase = getSupabaseAdminClient();
  const searchIds = filters.search
    ? await resolveSearchListingIds(supabase, filters.search)
    : null;

  if (filters.search && searchIds?.length === 0) {
    return { rows: [], totalCount: 0, page: 1, pageSize: PAGE_SIZE, totalPages: 1, filters, snapshotAt };
  }

  const sort = SORT_COLUMNS[filters.sort];
  const offset = (page - 1) * PAGE_SIZE;
  let query = supabase
    .from("listings_marketplace_v")
    .select(LISTING_COLUMNS, { count: "exact" })
    .order(sort.column, { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (searchIds) { query = query.in("id", searchIds); }
  if (filters.minKwh) { query = query.gte("pack_kwh", Number(filters.minKwh)); }
  if (filters.maxKwh) { query = query.lte("pack_kwh", Number(filters.maxKwh)); }
  if (filters.minWeightKg) { query = query.gte("pack_weight_kg", Number(filters.minWeightKg)); }
  if (filters.maxWeightKg) { query = query.lte("pack_weight_kg", Number(filters.maxWeightKg)); }
  if (filters.status) { query = query.eq("listing_status", filters.status); }
  if (filters.channel) { query = query.eq("channel_mode", filters.channel); }

  const response = await query;
  if (response.error) { throwReadError(); }
  const rawRows = (response.data ?? []) as unknown as MarketplaceRuntimeRow[];
  const ids = rawRows.flatMap((row) => row.id ? [row.id] : []);
  const referenceRows = ids.length > 0
    ? await readRows<{ id: string; reference: string | null; seo_slug: string | null }>(
        supabase.from("listings").select("id, reference, seo_slug").in("id", ids),
      )
    : [];
  const referenceById = new Map(referenceRows.map((row) => [row.id, row]));
  const rows = rawRows
    .map((row) => mapListRow(row, referenceById))
    .filter((row): row is ListingListRow => Boolean(row));
  const totalCount = response.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return {
    rows,
    totalCount,
    page: Math.min(page, totalPages),
    pageSize: PAGE_SIZE,
    totalPages,
    filters,
    snapshotAt,
  };
}

export async function getListingDetails(listingId: string): Promise<ListingDetail | null> {
  noStore();
  const id = typeof listingId === "string" ? listingId.trim().slice(0, 80) : "";
  if (!id) { return null; }

  const supabase = getSupabaseAdminClient();
  const listing = await readOne<ListingRow>(
    supabase
      .from("listings")
      .select("id, title, reference, seo_slug, supplier_account_id, created_by_user_id, channel_mode, listing_status, visibility, description, created_at, updated_at")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!listing) { return null; }

  const [specs, supplier] = await Promise.all([
    readOne<ListingSpecsRow>(
      supabase.from("listing_specs").select("*").eq("listing_id", id).maybeSingle(),
    ),
    readOne<AccountRow>(
      supabase.from("accounts").select("id, name, role, sector").eq("id", listing.supplier_account_id).maybeSingle(),
    ),
  ]);
  const location = parseLocation(specs?.location_address);

  const [activityRows, purchaseOffers, recyclingOffers, opportunityLinks, conversations, purchaseOfferCount, recyclingOfferCount, opportunityCount, conversationCount] = await Promise.all([
    readOptionalRows<ActivityCountRow>(() => supabase.rpc("get_listing_activity_counts", { listing_ids: [id] })),
    readOptionalRows<PurchaseOfferActivityRow>(() => supabase
      .from("purchase_offers")
      .select("id, status, buyer_account_id, quantity_requested, submitted_at")
      .eq("listing_id", id)
      .order("submitted_at", { ascending: false })
      .limit(MAX_ACTIVITY_ITEMS)),
    readOptionalRows<RecyclingOfferActivityRow>(() => supabase
      .from("recycling_offers")
      .select("id, status, recycler_account_id, submitted_at")
      .eq("listing_id", id)
      .order("submitted_at", { ascending: false })
      .limit(MAX_ACTIVITY_ITEMS)),
    readOptionalRows<OpportunityLinkRow>(() => supabase
      .from("recycler_opportunity_links")
      .select("id, link_type, state, recycler_account_id, created_at, updated_at, expires_at")
      .eq("listing_id", id)
      .order("updated_at", { ascending: false })
      .limit(MAX_ACTIVITY_ITEMS)),
    readOptionalRows<ConversationActivityRow>(() => supabase
      .from("conversations")
      .select("id, status, last_message_at, last_message_preview")
      .eq("listing_id", id)
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .limit(MAX_ACTIVITY_ITEMS)),
    readOptionalCount(() => supabase.from("purchase_offers").select("id", { count: "exact", head: true }).eq("listing_id", id)),
    readOptionalCount(() => supabase.from("recycling_offers").select("id", { count: "exact", head: true }).eq("listing_id", id)),
    readOptionalCount(() => supabase.from("recycler_opportunity_links").select("id", { count: "exact", head: true }).eq("listing_id", id)),
    readOptionalCount(() => supabase.from("conversations").select("id", { count: "exact", head: true }).eq("listing_id", id)),
  ]);

  const relatedAccountIds = [...new Set([
    ...purchaseOffers.map((offer) => offer.buyer_account_id),
    ...recyclingOffers.map((offer) => offer.recycler_account_id),
    ...opportunityLinks.map((link) => link.recycler_account_id),
  ])];
  const relatedAccounts = relatedAccountIds.length > 0
    ? await readOptionalRows<AccountRow>(() => supabase.from("accounts").select("id, name, role, sector").in("id", relatedAccountIds))
    : [];
  const accountsById = new Map(relatedAccounts.map((account) => [account.id, account]));
  const evidence = buildEvidence(listing, specs, location);
  const provenance = buildProvenance(listing, specs);
  const outbound = buildOutboundContext(
    listing,
    activityRows[0],
    purchaseOffers,
    recyclingOffers,
    purchaseOfferCount,
    recyclingOfferCount,
    opportunityLinks,
    opportunityCount,
    conversations,
    conversationCount,
    accountsById,
  );

  return {
    id: listing.id,
    title: listing.title,
    reference: listing.reference,
    seoSlug: listing.seo_slug,
    supplierAccountId: listing.supplier_account_id,
    supplierName: supplier?.name ?? null,
    status: listing.listing_status,
    channel: listing.channel_mode,
    visibility: listing.visibility,
    quantity: specs?.quantity ?? null,
    packKwh: specs?.pack_kwh ?? null,
    packWeightKg: specs?.pack_weight_kg ?? null,
    chemistry: specs?.chemistry ?? null,
    locationCity: location.city,
    locationRegion: location.region,
    locationCountry: location.country,
    updatedAt: listing.updated_at,
    createdAt: listing.created_at,
    description: listing.description,
    manufacturer: specs?.manufacturer ?? null,
    model: specs?.model ?? null,
    format: specs?.format ?? null,
    cellChemistryDetail: specs?.cell_chemistry_detail ?? null,
    condition: specs?.condition_json ?? {},
    minimumOrderQuantity: specs?.minimum_order_quantity ?? null,
    originalApplication: specs?.original_application ?? null,
    yearManufacture: specs?.year_manufacture ?? null,
    voltageNominal: specs?.voltage_nominal ?? null,
    soh: specs?.soh ?? null,
    evidence,
    provenance,
    outbound,
  };
}
