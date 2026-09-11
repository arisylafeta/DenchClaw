import "server-only";

import { unstable_noStore as noStore } from "next/cache";
import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import type { Database } from "@/lib/platform-admin/database.types";

export type BatteryRequest = Pick<
  Database["public"]["Tables"]["battery_requests"]["Row"],
  "id" | "session_id" | "contact_email" | "intent" | "request_json" | "created_at"
>;

export type BatteryRequestPage = {
  rows: BatteryRequest[];
  page: number;
  totalPages: number;
  totalCount: number;
  email: string;
};

const PAGE_SIZE = 25;
// Runtime, tracing and idempotency metadata stay on the server.
const COLUMNS = "id, session_id, contact_email, intent, request_json, created_at";

export async function getBatteryRequests(
  input: { page?: string; email?: string } = {},
): Promise<BatteryRequestPage> {
  noStore();
  const user = await currentUser();
  if (!user || !ALLOWED_EMAILS.has(user.email)) {
    throw new Error("Unauthorized");
  }

  const requestedPage = Number(input.page);
  let page = Number.isSafeInteger(requestedPage) ? Math.min(10_000, Math.max(1, requestedPage)) : 1;
  const email = (input.email ?? "").trim().slice(0, 254);
  const supabase = getSupabaseAdminClient();
  const read = (pageNumber: number) => {
    let query = supabase
      .from("battery_requests")
      .select(COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range((pageNumber - 1) * PAGE_SIZE, pageNumber * PAGE_SIZE - 1);
    // Escape LIKE metacharacters; the whole filter is a single bound value.
    if (email) {
      query = query.ilike("contact_email", `%${email.replace(/[\\%_]/g, "\\$&")}%`);
    }
    return query;
  };
  let response = await read(page);
  // PostgREST can reject a stale offset with 416 instead of returning an
  // empty page. Recover once at the beginning, without relying on an error body count.
  if (response.error?.code === "PGRST103" && page > 1) {
    page = 1;
    response = await read(page);
  }
  if (response.error) {
    throw new Error("Unable to load battery inquiries");
  }
  const totalCount = response.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (page > totalPages) {
    page = totalPages;
    response = await read(page);
    if (response.error) {
      throw new Error("Unable to load battery inquiries");
    }
  }
  return { rows: response.data ?? [], page, totalPages, totalCount, email };
}
