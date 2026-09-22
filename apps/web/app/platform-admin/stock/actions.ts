"use server";

import { unstable_noStore as noStore } from "next/cache";

import { queryPg } from "@/lib/postgres";
import {
  normalizeStockFilters,
  type StockDetail,
  type StockFilterOptions,
  type StockListRow,
  type StockPage,
  type StockPageInput,
  type StockSort,
  type StockStatus,
} from "./contract";

const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

type StockDbRow = {
  id: string;
  stock_id: string;
  supplier: string;
  make: string | null;
  model: string | null;
  model_detail?: string | null;
  year: string | null;
  powertrain?: string | null;
  part_number: string | null;
  description?: string | null;
  quantity: string | number;
  price?: string | number | null;
  location: string | null;
  condition?: string | null;
  comments?: string | null;
  chemistry: string | null;
  capacity_kwh: string | number | null;
  voltage_v?: string | number | null;
  weight_kg?: string | number | null;
  scope: string | null;
  part_number_status?: string | null;
  condition_detail?: string | null;
  soh_percent?: string | number | null;
  tested?: boolean | null;
  completeness?: string | null;
  photo_urls?: string[] | null;
  evidence?: unknown;
  attributes?: unknown;
  supplier_confirmed?: boolean;
  supplier_confirmed_at?: string | null;
  commercial_bucket: string | null;
  stock_status: StockStatus;
  enrich_status: string;
  aged_12m?: boolean;
  in_august?: boolean;
  in_september_aged?: boolean;
  listing_id?: string | null;
  enriched_at?: string | null;
  created_at: string;
  updated_at: string;
};

const SORT_SQL: Record<StockSort, string> = {
  updated_desc: "updated_at desc, id desc",
  uploaded_desc: "created_at desc, id desc",
  supplier_asc: "lower(supplier) asc, stock_id asc",
  status_asc: "stock_status asc, updated_at desc, id desc",
};

function safePage(value: unknown): number {
  const page = typeof value === "number" ? value : Number(value);
  return Number.isFinite(page)
    ? Math.min(MAX_PAGE, Math.max(1, Math.floor(page)))
    : 1;
}

function numeric(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {return null;}
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function mapListRow(row: StockDbRow): StockListRow {
  return {
    id: row.id,
    stockId: row.stock_id,
    supplier: row.supplier,
    make: row.make,
    model: row.model,
    year: row.year,
    partNumber: row.part_number,
    quantity: numeric(row.quantity) ?? 0,
    location: row.location,
    chemistry: row.chemistry,
    capacityKwh: numeric(row.capacity_kwh),
    scope: row.scope,
    stockStatus: row.stock_status,
    commercialBucket: row.commercial_bucket,
    enrichStatus: row.enrich_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function distinctValues(column: string): Promise<string[]> {
  const allowed = new Set(["supplier", "chemistry", "scope", "commercial_bucket"]);
  if (!allowed.has(column)) {return [];}
  const rows = await queryPg<{ value: string }>(
    `select distinct ${column} as value from crm_stock_items
     where ${column} is not null and btrim(${column}) <> ''
     order by value asc`,
  );
  return rows.map((row) => row.value);
}

export async function getStockPage(input: StockPageInput = {}): Promise<StockPage> {
  noStore();
  const filters = normalizeStockFilters(input);
  const page = safePage(input.page);
  const clauses = ["true"];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };

  if (filters.search) {
    add(
      `concat_ws(' ', stock_id, supplier, make, model, model_detail, year,
        part_number, description, location, comments, commercial_bucket)
        ilike ?`,
      `%${filters.search}%`,
    );
  }
  if (filters.supplier) {add("supplier = ?", filters.supplier);}
  if (filters.status) {add("stock_status = ?", filters.status);}
  if (filters.chemistry) {add("chemistry = ?", filters.chemistry);}
  if (filters.scope) {add("scope = ?", filters.scope);}
  if (filters.commercialBucket) {
    add("commercial_bucket = ?", filters.commercialBucket);
  }

  const where = clauses.join(" and ");
  const offset = (page - 1) * PAGE_SIZE;
  const rowParams = [...params, PAGE_SIZE, offset];
  const [rows, countRows, allRows, suppliers, chemistries, scopes, buckets] =
    await Promise.all([
      queryPg<StockDbRow>(
        `select id, stock_id, supplier, make, model, year, part_number, quantity,
          location, chemistry, capacity_kwh, scope, stock_status,
          commercial_bucket, enrich_status, created_at, updated_at
         from crm_stock_items where ${where}
         order by ${SORT_SQL[filters.sort]}
         limit $${params.length + 1} offset $${params.length + 2}`,
        rowParams,
      ),
      queryPg<{ count: number }>(
        `select count(*)::int as count from crm_stock_items where ${where}`,
        params,
      ),
      queryPg<{ count: number }>(
        "select count(*)::int as count from crm_stock_items",
      ),
      distinctValues("supplier"),
      distinctValues("chemistry"),
      distinctValues("scope"),
      distinctValues("commercial_bucket"),
    ]);

  const totalCount = Number(countRows[0]?.count ?? 0);
  const options: StockFilterOptions = {
    suppliers,
    chemistries,
    scopes,
    commercialBuckets: buckets,
  };
  return {
    rows: rows.map(mapListRow),
    totalCount,
    allCount: Number(allRows[0]?.count ?? 0),
    page,
    pageSize: PAGE_SIZE,
    totalPages: Math.max(1, Math.ceil(totalCount / PAGE_SIZE)),
    filters,
    options,
    snapshotAt: new Date().toISOString(),
  };
}

export async function getStockDetails(id: string): Promise<StockDetail | null> {
  noStore();
  if (!/^stock-[0-9a-f]{24}$/.test(id)) {return null;}
  const rows = await queryPg<StockDbRow>(
    `select * from crm_stock_items where id = $1 limit 1`,
    [id],
  );
  const row = rows[0];
  if (!row) {return null;}
  return {
    ...mapListRow(row),
    modelDetail: row.model_detail ?? null,
    powertrain: row.powertrain ?? null,
    description: row.description ?? null,
    price: numeric(row.price),
    condition: row.condition ?? null,
    comments: row.comments ?? null,
    voltageV: numeric(row.voltage_v),
    weightKg: numeric(row.weight_kg),
    partNumberStatus: row.part_number_status ?? null,
    conditionDetail: row.condition_detail ?? null,
    sohPercent: numeric(row.soh_percent),
    tested: row.tested ?? null,
    completeness: row.completeness ?? null,
    photoUrls: row.photo_urls ?? [],
    evidence: row.evidence ?? {},
    attributes: row.attributes ?? {},
    supplierConfirmed: row.supplier_confirmed ?? false,
    supplierConfirmedAt: row.supplier_confirmed_at ?? null,
    aged12m: row.aged_12m ?? false,
    inAugust: row.in_august ?? false,
    inSeptemberAged: row.in_september_aged ?? false,
    listingId: row.listing_id ?? null,
    enrichedAt: row.enriched_at ?? null,
  };
}
