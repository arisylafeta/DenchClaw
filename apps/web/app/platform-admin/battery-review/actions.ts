"use server";

import { unstable_noStore as noStore } from "next/cache";
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
  const [manufacturers, chemistries] = await Promise.all([
    db.from("batteries").select("manufacturer").range(0, 4_999),
    db.from("batteries").select("chemistry").range(0, 4_999),
  ]);

  if (manufacturers.error) throw new Error(manufacturers.error.message);
  if (chemistries.error) throw new Error(chemistries.error.message);

  return {
    manufacturers: uniqueLabels(manufacturers.data as Array<Record<string, unknown>> | null, "manufacturer"),
    chemistries: uniqueLabels(chemistries.data as Array<Record<string, unknown>> | null, "chemistry"),
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
      .select("*", { count: "exact" })
      .order(sort, { ascending, nullsFirst: false })
      .range(from, to);

    if (search) {
      const term = `%${search.replaceAll(",", " ")}%`;
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
    .select("*", { count: "exact" })
    .order(sort, { ascending, nullsFirst: false })
    .range(from, to);

  if (search) {
    const term = `%${search.replaceAll(",", " ")}%`;
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
    const { data: batteries, error: batteriesError } = await db
      .from("batteries")
      .select("*")
      .in("id", batteryIds);
    if (batteriesError) throw new Error(batteriesError.message);
    for (const battery of batteries ?? []) {
      batteriesById.set(battery.id, battery as BatteryReviewRow);
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
