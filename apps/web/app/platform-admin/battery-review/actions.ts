"use server";

import { unstable_noStore as noStore } from "next/cache";
import { readAllRows, readRowsInBatches } from "@/lib/platform-admin/queries";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";

export type BatteryReviewTab = "canonical" | "evidence";

export type BatteryReviewRow = Record<string, unknown>;

export type BatteryEvidenceRow = BatteryReviewRow & {
  id: string;
  selected_battery_id: string | null;
  matched_battery_id: string | null;
  linked_battery: BatteryReviewRow | null;
};

export type BatteryReviewPage<T> = {
  rows: T[];
  totalCount: number;
  page: number;
  pageSize: number;
};

export type BatteryReviewQuery = {
  tab: BatteryReviewTab;
  page?: number;
  pageSize?: number;
  search?: string;
  manufacturer?: string;
  chemistry?: string;
  sort?: string;
  ascending?: boolean;
};

export type BatteryFilterOptions = {
  manufacturers: string[];
  chemistries: string[];
};

const PAGE_SIZE = 25;
const CANONICAL_LIST_COLUMNS = "id, manufacturer, model, chemistry, nominal_kwh, part_number, updated_at, catalogue_image_url";
const EVIDENCE_LIST_COLUMNS = "id, selected_battery_id, matched_battery_id, changed_fields, previous_values, submitted_values, source_context, source_flow, created_at";

const CANONICAL_SORT_COLUMNS = new Set([
  "updated_at",
  "created_at",
  "manufacturer",
  "model",
  "chemistry",
  "nominal_kwh",
  "from_year",
  "to_year",
]);

const EVIDENCE_SORT_COLUMNS = new Set([
  "created_at",
  "source_flow",
  "source_context",
]);

function reviewDb() {
  // The copied generated types do not yet include these shared catalog tables.
  // Keep the narrow escape hatch server-only until the next type regeneration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSupabaseAdminClient() as any;
}

function normaliseQuery(input: BatteryReviewQuery) {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.floor(input.pageSize ?? PAGE_SIZE)));
  const search = input.search?.trim().slice(0, 120) ?? "";
  const manufacturer = input.manufacturer?.trim().slice(0, 120) ?? "";
  const chemistry = input.chemistry?.trim().slice(0, 120) ?? "";
  const allowedSorts = input.tab === "canonical" ? CANONICAL_SORT_COLUMNS : EVIDENCE_SORT_COLUMNS;
  const defaultSort = input.tab === "canonical" ? "updated_at" : "created_at";
  const sort = allowedSorts.has(input.sort ?? "") ? input.sort! : defaultSort;

  return { page, pageSize, search, manufacturer, chemistry, sort, ascending: input.ascending ?? false };
}

function uniqueLabels(rows: Array<Record<string, unknown>> | null, field: string): string[] {
  return [...new Set((rows ?? []).flatMap((row) => {
    const value = row[field];
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }))].sort((left, right) => left.localeCompare(right));
}

export async function getBatteryFilterOptions(): Promise<BatteryFilterOptions> {
  noStore();
  const db = reviewDb();
  const rows = await readAllRows<Record<string, unknown>>(
    (from, to) => db
      .from("batteries")
      .select("manufacturer, chemistry")
      .order("id", { ascending: true })
      .range(from, to),
    { maxRows: 10_000 },
  );

  return {
    manufacturers: uniqueLabels(rows, "manufacturer"),
    chemistries: uniqueLabels(rows, "chemistry"),
  };
}

export async function getBatteryReviewPage(
  input: BatteryReviewQuery,
): Promise<BatteryReviewPage<BatteryReviewRow> | BatteryReviewPage<BatteryEvidenceRow>> {
  noStore();
  const { page, pageSize, search, manufacturer, chemistry, sort, ascending } = normaliseQuery(input);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const db = reviewDb();

  if (input.tab === "canonical") {
    let query = db
      .from("batteries")
      .select(CANONICAL_LIST_COLUMNS, { count: "exact" })
      .order(sort, { ascending, nullsFirst: false })
      .range(from, to);

    if (search) {
      const term = `%${search.replace(/[,().%]/g, " ")}%`;
      query = query.or(`manufacturer.ilike.${term},model.ilike.${term},chemistry.ilike.${term},part_number.ilike.${term}`);
    }
    if (manufacturer) query = query.ilike("manufacturer", `%${manufacturer}%`);
    if (chemistry) query = query.ilike("chemistry", `%${chemistry}%`);

    const { data, error, count } = await query;
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as BatteryReviewRow[], totalCount: count ?? 0, page, pageSize };
  }

  let query = db
    .from("battery_evidence")
    .select(EVIDENCE_LIST_COLUMNS, { count: "exact" })
    .order(sort, { ascending, nullsFirst: false })
    .range(from, to);

  if (search) {
    const term = `%${search.replace(/[,().%]/g, " ")}%`;
    query = query.or(`source_flow.ilike.${term},source_context.ilike.${term},submitted_values_hash.ilike.${term}`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  const evidence = (data ?? []) as Array<{
    id: string;
    selected_battery_id: string | null;
    matched_battery_id: string | null;
    [key: string]: unknown;
  }>;
  const batteryIds = [...new Set(evidence.flatMap((row) => [row.selected_battery_id, row.matched_battery_id]).filter(Boolean))] as string[];
  const batteriesById = new Map<string, BatteryReviewRow>();

  if (batteryIds.length > 0) {
    const batteries = await readRowsInBatches<BatteryReviewRow>(batteryIds, (ids) => db
      .from("batteries")
      .select("id, manufacturer, model, nominal_kwh")
      .in("id", ids));
    for (const battery of batteries) {
      if (typeof battery.id === "string") batteriesById.set(battery.id, battery);
    }
  }

  return {
    rows: evidence.map((row) => ({
      ...row,
      // Selected is the explicit canonical selection. A match is shown as context
      // only, so no review UI can accidentally treat a heuristic match as approval.
      linked_battery: row.selected_battery_id ? batteriesById.get(row.selected_battery_id) ?? null : null,
    })),
    totalCount: count ?? 0,
    page,
    pageSize,
  };
}

export async function getBatteryReviewDetails(input: {
  tab: BatteryReviewTab;
  id: string;
}): Promise<{ row: BatteryReviewRow; linked: BatteryReviewRow | null }> {
  noStore();
  const id = input.id.trim();
  if (!id || id.length > 120) throw new Error("Invalid battery review row ID");

  const db = reviewDb();
  const table = input.tab === "canonical" ? "batteries" : "battery_evidence";
  const { data, error } = await db.from(table).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Battery review row not found");

  const row = data as BatteryReviewRow;
  if (input.tab === "canonical") return { row, linked: null };

  const selectedBatteryId = row.selected_battery_id;
  if (typeof selectedBatteryId !== "string" || !selectedBatteryId) {
    return { row, linked: null };
  }

  const { data: linked, error: linkedError } = await db
    .from("batteries")
    .select("*")
    .eq("id", selectedBatteryId)
    .maybeSingle();
  if (linkedError) throw new Error(linkedError.message);
  return { row, linked: (linked as BatteryReviewRow | null) ?? null };
}
