export const STOCK_STATUSES = [
  "unverified",
  "available",
  "listed",
  "contacted",
  "in_deal",
  "sold",
  "unavailable",
] as const;

export const STOCK_SORTS = [
  "updated_desc",
  "uploaded_desc",
  "supplier_asc",
  "status_asc",
] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];
export type StockSort = (typeof STOCK_SORTS)[number];

export type StockFilters = {
  search: string;
  supplier: string;
  status: StockStatus | "";
  chemistry: string;
  scope: string;
  commercialBucket: string;
  sort: StockSort;
};

export type StockListRow = {
  id: string;
  stockId: string;
  supplier: string;
  make: string | null;
  model: string | null;
  year: string | null;
  partNumber: string | null;
  quantity: number;
  location: string | null;
  chemistry: string | null;
  capacityKwh: number | null;
  scope: string | null;
  stockStatus: StockStatus;
  commercialBucket: string | null;
  enrichStatus: string;
  createdAt: string;
  updatedAt: string;
};

export type StockDetail = StockListRow & {
  modelDetail: string | null;
  powertrain: string | null;
  description: string | null;
  price: number | null;
  condition: string | null;
  comments: string | null;
  voltageV: number | null;
  weightKg: number | null;
  partNumberStatus: string | null;
  conditionDetail: string | null;
  sohPercent: number | null;
  tested: boolean | null;
  completeness: string | null;
  photoUrls: string[];
  evidence: unknown;
  attributes: unknown;
  supplierConfirmed: boolean;
  supplierConfirmedAt: string | null;
  aged12m: boolean;
  inAugust: boolean;
  inSeptemberAged: boolean;
  listingId: string | null;
  enrichedAt: string | null;
};

export type StockFilterOptions = {
  suppliers: string[];
  chemistries: string[];
  scopes: string[];
  commercialBuckets: string[];
};

export type StockPage = {
  rows: StockListRow[];
  totalCount: number;
  allCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  filters: StockFilters;
  options: StockFilterOptions;
  snapshotAt: string;
};

export type StockPageInput = Partial<Omit<StockFilters, "sort">> & {
  page?: number;
  sort?: string;
};

function cleanText(value: unknown, maxLength = 120): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanSearch(value: unknown): string {
  return cleanText(value, 100)
    .replace(/[\\%_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanAllowed<T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | "" {
  const candidate = cleanText(value, 40);
  return (allowed as readonly string[]).includes(candidate)
    ? (candidate as T[number])
    : "";
}

export function normalizeStockFilters(input: StockPageInput = {}): StockFilters {
  return {
    search: cleanSearch(input.search),
    supplier: cleanText(input.supplier, 100),
    status: cleanAllowed(input.status, STOCK_STATUSES),
    chemistry: cleanText(input.chemistry, 100),
    scope: cleanText(input.scope, 100),
    commercialBucket: cleanText(input.commercialBucket, 100),
    sort: cleanAllowed(input.sort, STOCK_SORTS) || "updated_desc",
  };
}
