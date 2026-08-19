import type { Database, Json } from "@/lib/platform-admin/database.types";

export const LISTING_STATUSES = ["draft", "published", "withdrawn", "completed"] as const;
export const LISTING_CHANNELS = ["sale", "recycling"] as const;
export const LISTING_SORTS = [
  "updated_desc",
  "updated_asc",
  "capacity_desc",
  "capacity_asc",
  "weight_desc",
  "weight_asc",
] as const;

export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type ListingChannel = (typeof LISTING_CHANNELS)[number];
export type ListingSort = (typeof LISTING_SORTS)[number];

export type ListingFilters = {
  search: string;
  minKwh: string;
  maxKwh: string;
  minWeightKg: string;
  maxWeightKg: string;
  status: ListingStatus | "";
  channel: ListingChannel | "";
  sort: ListingSort;
};

export type ListingListRow = {
  id: string;
  title: string | null;
  reference: string | null;
  seoSlug: string | null;
  supplierAccountId: string | null;
  supplierName: string | null;
  status: Database["public"]["Enums"]["listing_status"] | null;
  channel: Database["public"]["Enums"]["listing_channel_mode"] | null;
  visibility: Database["public"]["Enums"]["listing_visibility"] | null;
  quantity: number | null;
  packKwh: number | null;
  packWeightKg: number | null;
  chemistry: string | null;
  locationCity: string | null;
  locationRegion: string | null;
  locationCountry: string | null;
  updatedAt: string | null;
  createdAt: string | null;
};

export type ListingDetail = ListingListRow & {
  description: string | null;
  manufacturer: string | null;
  model: string | null;
  format: string | null;
  cellChemistryDetail: string | null;
  condition: Json;
  minimumOrderQuantity: number | null;
  originalApplication: string | null;
  yearManufacture: number | null;
  voltageNominal: number | null;
  soh: number | null;
};

export type ListingPage = {
  rows: ListingListRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: ListingFilters;
};

export type ListingPageInput = Partial<Omit<ListingFilters, "sort">> & {
  page?: number;
  sort?: string;
};

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanSearchText(value: unknown): string {
  return cleanText(value, 100).replace(/[(),*%_"'\\]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanNumberText(value: unknown): string {
  const candidate = cleanText(value, 20).replace(",", ".");
  if (!candidate || !/^\d+(?:\.\d{1,2})?$/.test(candidate)) { return ""; }
  const parsed = Number(candidate);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) { return ""; }
  return String(parsed);
}

function cleanEnum<T extends readonly string[]>(value: unknown, allowed: T): T[number] | "" {
  const candidate = cleanText(value, 40);
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T[number]) : "";
}

function normaliseRange(min: string, max: string): [string, string] {
  if (min && max && Number(min) > Number(max)) { return [max, min]; }
  return [min, max];
}

export function normalizeListingFilters(input: ListingPageInput = {}): ListingFilters {
  const [minKwh, maxKwh] = normaliseRange(
    cleanNumberText(input.minKwh),
    cleanNumberText(input.maxKwh),
  );
  const [minWeightKg, maxWeightKg] = normaliseRange(
    cleanNumberText(input.minWeightKg),
    cleanNumberText(input.maxWeightKg),
  );

  return {
    search: cleanSearchText(input.search),
    minKwh,
    maxKwh,
    minWeightKg,
    maxWeightKg,
    status: cleanEnum(input.status, LISTING_STATUSES),
    channel: cleanEnum(input.channel, LISTING_CHANNELS),
    sort: cleanEnum(input.sort, LISTING_SORTS) || "updated_desc",
  };
}
