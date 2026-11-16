import { withPgTransaction } from "../postgres";

export type ReviewDecision = "approve" | "reject";

/**
 * A person's verdict on an imported listing flagged for review. Approve keeps it as a real bulk deal; reject closes it
 * as not a fit (reopenable). Only a listing still waiting for review changes. Returns "ok", "missing" or "not_pending".
 */
export async function reviewListing(id: string, decision: ReviewDecision, actorUserId: string | null): Promise<"ok" | "missing" | "not_pending"> {
  return withPgTransaction(async (tx) => {
    const { rows } = await tx.query<{ status: string; review_state: string | null }>(
      `select status, context->'review'->>'state' as review_state from crm_bulk_listings where id = $1 for update`, [id]);
    const current = rows[0];
    if (!current) return "missing";
    if (current.review_state !== "needs_review") return "not_pending";
    const state = decision === "approve" ? "approved" : "rejected";
    await tx.query(
      `update crm_bulk_listings
          set context = jsonb_set(context, '{review}', (context->'review') || jsonb_build_object('state', $2::text, 'decided_at', now(), 'decided_by', $3::text)),
              status = case when $4 then 'closed' else status end,
              closed_reason = case when $4 then 'not_a_fit' else closed_reason end,
              next_action = case when $4 then null else next_action end,
              next_due = case when $4 then null else next_due end,
              updated_at = now()
        where id = $1`,
      [id, state, actorUserId, decision === "reject"]);
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data, actor_user_id) values ($1, 'status', $2, $3::jsonb, $4)`,
      [id, decision === "approve" ? "Reviewed: a genuine bulk deal" : "Reviewed: not a bulk deal, closed",
        JSON.stringify({ review: state, previous_status: current.status }), actorUserId]);
    return "ok";
  });
}
