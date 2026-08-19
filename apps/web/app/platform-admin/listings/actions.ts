"use server";

import { unstable_noStore as noStore } from "next/cache";

import type { Database } from "@/lib/platform-admin/database.types";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  normalizeListingFilters,
  type ListingDetail,
  type ListingListRow,
  type ListingPage,
  type ListingPageInput,
  type ListingSort,
} from "./contract";

const PAGE_SIZE = 25;
const MAX_PAGE = 10_000;
const MAX_SEARCH_MATCHES = 250;

type MarketplaceRow = Database["public"]["Views"]["listings_marketplace_v"]["Row"];
type ListingRow = Pick<
  Database["public"]["Tables"]["listings"]["Row"],
  | "id"
  | "title"
  | "reference"
  | "seo_slug"
  | "supplier_account_id"
  | "channel_mode"
  | "listing_status"
  | "visibility"
  | "description"
  | "created_at"
  | "updated_at"
>;
type ListingSpecsRow = Database["public"]["Tables"]["listing_specs"]["Row"];
type AccountRow = Pick<Database["public"]["Tables"]["accounts"]["Row"], "id" | "name">;

type ReadResult = {
  data: unknown;
  error: { message: string } | null;
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
  "location_city",
  "location_region",
  "location_country",
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
          `location_city.ilike.${pattern}`,
          `location_region.ilike.${pattern}`,
          `location_country.ilike.${pattern}`,
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
          `chemistry.ilike.${pattern}`,
          `location_city.ilike.${pattern}`,
          `location_region.ilike.${pattern}`,
          `location_country.ilike.${pattern}`,
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

function mapListRow(
  row: MarketplaceRow,
  referenceById: Map<string, { reference: string | null; seo_slug: string | null }>,
): ListingListRow | null {
  if (!row.id) { return null; }
  const listing = referenceById.get(row.id);
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
    locationCity: row.location_city,
    locationRegion: row.location_region,
    locationCountry: row.location_country,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export async function getListingPage(input: ListingPageInput = {}): Promise<ListingPage> {
  noStore();
  const filters = normalizeListingFilters(input);
  const page = safePage(input.page);
  const supabase = getSupabaseAdminClient();
  const searchIds = filters.search
    ? await resolveSearchListingIds(supabase, filters.search)
    : null;

  if (filters.search && searchIds?.length === 0) {
    return { rows: [], totalCount: 0, page: 1, pageSize: PAGE_SIZE, totalPages: 1, filters };
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
  const rawRows = (response.data ?? []) as unknown as MarketplaceRow[];
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
      .select("id, title, reference, seo_slug, supplier_account_id, channel_mode, listing_status, visibility, description, created_at, updated_at")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!listing) { return null; }

  const [specs, supplier] = await Promise.all([
    readOne<ListingSpecsRow>(
      supabase.from("listing_specs").select("*").eq("listing_id", id).maybeSingle(),
    ),
    readOne<AccountRow>(
      supabase.from("accounts").select("id, name").eq("id", listing.supplier_account_id).maybeSingle(),
    ),
  ]);

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
    locationCity: specs?.location_city ?? null,
    locationRegion: specs?.location_region ?? null,
    locationCountry: specs?.location_country ?? null,
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
  };
}
