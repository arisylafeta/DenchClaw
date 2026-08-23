"use server";

import { unstable_noStore as noStore } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import {
  buildBatteryEvidenceDifferences,
  buildStoredReviewDifferences,
  type BatteryEvidenceDifference,
  type BatteryEvidenceStatus,
  type CanonicalApplicationContext,
} from "./diff";

export type BatteryEvidenceRow = Record<string, unknown> & {
  id: string;
  canonical_application_id: string | null;
  status: BatteryEvidenceStatus;
  submitted_values: unknown;
  canonical_context: CanonicalApplicationContext | null;
  differences: BatteryEvidenceDifference[];
};

export type BatteryEvidencePage = {
  rows: BatteryEvidenceRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  schemaReady: boolean;
};

export type BatteryEvidenceQuery = {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: BatteryEvidenceStatus | "all";
  sort?: "created_at" | "reviewed_at" | "status";
  ascending?: boolean;
};

export type BatteryEvidenceReviewInput = {
  evidenceId: string;
  action: "verify" | "dismiss" | "apply";
  reviewerName: string;
  note: string;
  canonicalApplicationId?: string | null;
  approvedFields?: string[];
  expectedVehicleUpdatedAt?: string | null;
  expectedBatteryUpdatedAt?: string | null;
  expectedApplicationUpdatedAt?: string | null;
};

const PAGE_SIZE = 25;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reviewDb() {
  // DenchClaw's copied generated types lag the shared schema. Keep this escape
  // hatch inside the server-only review boundary until its next type refresh.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSupabaseAdminClient() as any;
}

function cleanText(value: string, label: string, min: number, max: number): string {
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) {
    throw new Error(`${label} must contain ${min} to ${max} characters.`);
  }
  return cleaned;
}

function cleanUuid(value: string | null | undefined, label: string): string | null {
  const cleaned = value?.trim() ?? "";
  if (!cleaned) {
    return null;
  }
  if (!UUID.test(cleaned)) {
    throw new Error(`${label} is invalid.`);
  }
  return cleaned;
}

function contextLabel(
  vehicle: Record<string, unknown>,
  battery: Record<string, unknown>,
  application: Record<string, unknown>,
): string {
  const capacity = battery.marketed_kwh ?? battery.nominal_kwh ?? battery.usable_kwh;
  const capacityLabel =
    typeof capacity === "string" || typeof capacity === "number" ? `${capacity} kWh` : null;
  const parts = [
    vehicle.make,
    vehicle.model,
    application.generation,
    capacityLabel,
    battery.chemistry_family,
  ];
  return parts
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" · ");
}

async function loadCanonicalContexts(
  applicationIds: string[],
): Promise<Map<string, CanonicalApplicationContext>> {
  const ids = [...new Set(applicationIds.filter((id) => UUID.test(id)))];
  const result = new Map<string, CanonicalApplicationContext>();
  if (ids.length === 0) {
    return result;
  }

  const db = reviewDb();
  const { data: applications, error: applicationsError } = await db
    .from("canonical_battery_applications")
    .select("*")
    .in("id", ids);
  if (applicationsError) {
    throw new Error(applicationsError.message);
  }

  const applicationRows = (applications ?? []) as Array<
    Record<string, unknown> & {
      id: string;
      battery_id: string;
      vehicle_model_id: string;
      updated_at: string;
    }
  >;
  const batteryIds = [...new Set(applicationRows.map((row) => row.battery_id))];
  const vehicleIds = [...new Set(applicationRows.map((row) => row.vehicle_model_id))];
  const [batteriesResult, vehiclesResult] = await Promise.all([
    db.from("canonical_batteries").select("*").in("id", batteryIds),
    db.from("canonical_vehicle_models").select("*").in("id", vehicleIds),
  ]);
  if (batteriesResult.error) {
    throw new Error(batteriesResult.error.message);
  }
  if (vehiclesResult.error) {
    throw new Error(vehiclesResult.error.message);
  }

  const batteries = new Map<string, Record<string, unknown> & { id: string; updated_at: string }>(
    (batteriesResult.data ?? []).map(
      (row: Record<string, unknown> & { id: string; updated_at: string }) => [row.id, row],
    ),
  );
  const vehicles = new Map<string, Record<string, unknown> & { id: string; updated_at: string }>(
    (vehiclesResult.data ?? []).map(
      (row: Record<string, unknown> & { id: string; updated_at: string }) => [row.id, row],
    ),
  );

  for (const application of applicationRows) {
    const battery = batteries.get(application.battery_id);
    const vehicle = vehicles.get(application.vehicle_model_id);
    if (!battery || !vehicle) {
      continue;
    }
    result.set(application.id, {
      label: contextLabel(vehicle, battery, application),
      application,
      battery,
      vehicle,
    });
  }
  return result;
}

export async function getBatteryEvidencePage(
  input: BatteryEvidenceQuery = {},
): Promise<BatteryEvidencePage> {
  noStore();
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(10, Math.floor(input.pageSize ?? PAGE_SIZE)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const status = input.status ?? "pending";
  const sort = input.sort ?? "created_at";
  const search =
    input.search
      ?.trim()
      .slice(0, 120)
      .replace(/[,%().]/g, " ") ?? "";
  const db = reviewDb();

  let query = db
    .from("battery_evidence")
    .select("*", { count: "exact" })
    .order(sort, { ascending: input.ascending ?? false, nullsFirst: false })
    .range(from, to);
  if (status !== "all") {
    query = query.eq("status", status);
  }
  if (search) {
    const term = `%${search}%`;
    query = query.or(
      `source_flow.ilike.${term},source_context.ilike.${term},submitted_values_hash.ilike.${term}`,
    );
  }

  const { data, error, count } = await query;
  if (error) {
    const missingReviewSchema =
      error.code === "42703" ||
      error.code === "PGRST204" ||
      /status|canonical_application_id|submitted_values_hash/i.test(error.message);
    if (missingReviewSchema) {
      return { rows: [], totalCount: 0, page, pageSize, schemaReady: false };
    }
    throw new Error(error.message);
  }

  const evidenceRows = (data ?? []) as Array<
    Record<string, unknown> & {
      id: string;
      canonical_application_id: string | null;
      status: BatteryEvidenceStatus;
      submitted_values: unknown;
    }
  >;
  const contexts = await loadCanonicalContexts(
    evidenceRows.flatMap((row) =>
      row.canonical_application_id ? [row.canonical_application_id] : [],
    ),
  );

  return {
    rows: evidenceRows.map((row) => {
      const context = row.canonical_application_id
        ? (contexts.get(row.canonical_application_id) ?? null)
        : null;
      return {
        ...row,
        canonical_context: context,
        differences:
          row.status === "pending"
            ? buildBatteryEvidenceDifferences(row.submitted_values, context)
            : row.status === "applied"
              ? buildStoredReviewDifferences(
                  row.canonical_before,
                  row.reviewed_values,
                  row.approved_fields,
                )
              : [],
      };
    }),
    totalCount: count ?? 0,
    page,
    pageSize,
    schemaReady: true,
  };
}

export async function getCanonicalApplicationContext(
  applicationId: string,
): Promise<CanonicalApplicationContext | null> {
  noStore();
  const id = cleanUuid(applicationId, "Canonical application ID");
  if (!id) {
    return null;
  }
  return (await loadCanonicalContexts([id])).get(id) ?? null;
}

export async function searchCanonicalApplications(
  query: string,
): Promise<CanonicalApplicationContext[]> {
  noStore();
  const search = query.trim().slice(0, 120);
  if (search.length < 2) {
    return [];
  }
  const db = reviewDb();
  const { data, error } = await db.rpc("search_canonical_battery_applications", {
    p_query: search,
    p_limit: 8,
  });
  if (error) {
    throw new Error(error.message);
  }
  const ids = (data ?? []).flatMap((row: Record<string, unknown>) =>
    typeof row.application_id === "string" ? [row.application_id] : [],
  );
  const contexts = await loadCanonicalContexts(ids);
  return ids.flatMap((id: string) => (contexts.has(id) ? [contexts.get(id)!] : []));
}

export async function reviewBatteryEvidence(input: BatteryEvidenceReviewInput): Promise<{
  status: BatteryEvidenceStatus;
}> {
  noStore();
  const evidenceId = cleanUuid(input.evidenceId, "Evidence ID");
  if (!evidenceId) {
    throw new Error("Evidence ID is required.");
  }
  const reviewerName = cleanText(input.reviewerName, "Reviewer name", 2, 100);
  const note = cleanText(input.note, "Review note", 2, 1000);
  const canonicalApplicationId = cleanUuid(
    input.canonicalApplicationId,
    "Canonical application ID",
  );
  const approvedFields = [...new Set(input.approvedFields ?? [])];
  const db = reviewDb();

  const { data: evidence, error: evidenceError } = await db
    .from("battery_evidence")
    .select("id,status,submitted_values,canonical_application_id")
    .eq("id", evidenceId)
    .maybeSingle();
  if (evidenceError) {
    throw new Error(evidenceError.message);
  }
  if (!evidence) {
    throw new Error("Battery evidence was not found.");
  }
  if (evidence.status !== "pending") {
    throw new Error("This evidence was already reviewed.");
  }

  const resolvedApplicationId = canonicalApplicationId ?? evidence.canonical_application_id ?? null;
  const context = resolvedApplicationId
    ? await getCanonicalApplicationContext(resolvedApplicationId)
    : null;
  const differences = buildBatteryEvidenceDifferences(evidence.submitted_values, context);
  const differencesByField = new Map(
    differences.map((difference) => [difference.field, difference]),
  );
  const reviewedValues = Object.fromEntries(
    approvedFields.map((field) => {
      const difference = differencesByField.get(field);
      if (!difference) {
        throw new Error(`Field ${field} is no longer an applicable difference.`);
      }
      return [field, difference.submitted];
    }),
  );

  if (input.action === "apply" && approvedFields.length === 0) {
    throw new Error("Select at least one difference to apply.");
  }

  const { data, error } = await db.rpc("review_battery_evidence", {
    p_evidence_id: evidenceId,
    p_action: input.action,
    p_reviewer_name: reviewerName,
    p_review_note: note,
    p_canonical_application_id: resolvedApplicationId,
    p_approved_fields: input.action === "apply" ? approvedFields : [],
    p_reviewed_values: input.action === "apply" ? reviewedValues : {},
    p_expected_vehicle_updated_at: input.expectedVehicleUpdatedAt ?? null,
    p_expected_battery_updated_at: input.expectedBatteryUpdatedAt ?? null,
    p_expected_application_updated_at: input.expectedApplicationUpdatedAt ?? null,
  });
  if (error) {
    throw new Error(error.message);
  }
  const status = data?.[0]?.review_status;
  if (!(["verified", "dismissed", "applied"] as string[]).includes(status)) {
    throw new Error("Battery evidence review did not return a valid result.");
  }
  return { status: status as BatteryEvidenceStatus };
}
