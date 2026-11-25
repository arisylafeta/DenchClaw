import { withPgTransaction } from "../postgres";
import { abandonReasonLabel, isAbandonReason } from "../bulk-abandon";
import type { ListingKind } from "../bulk-listing";

/** Offer stages still in play. Abandoning a listing marks these lost; paid, complete, declined and lost stay as they are. */
const LIVE_OFFER_STAGES = ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced"];

export type AbandonResult = "ok" | "missing" | "closed" | "bad_reason";
export type ReopenResult = "ok" | "missing" | "open";

type Actor = { userId: string | null; email: string | null };

/**
 * Deals board, dragged to Abandoned: closes the listing with the reason (an existing closed_reason) and marks its live
 * offers lost, so a paired listing on the other side leaves the deal columns too. What it was is kept for a reopen:
 * context.abandoned on the listing ({at, by, from_status}) and data.abandoned on each offer ({listing_id, stage}).
 * One Story note says why. Nothing is deleted.
 */
export async function abandonListing(id: string, reason: unknown, note: string | null, actor: Actor): Promise<AbandonResult> {
  return withPgTransaction(async (tx) => {
    const found = await tx.query<{ kind: ListingKind; status: string }>("select kind, status from crm_bulk_listings where id = $1 for update", [id]);
    const listing = found.rows[0];
    if (!listing) return "missing";
    if (listing.status === "closed") return "closed";
    if (!isAbandonReason(listing.kind, reason)) return "bad_reason";
    const offers = await tx.query(
      `update crm_bulk_offers
          set data = data || jsonb_build_object('abandoned', jsonb_build_object('listing_id', $1::text, 'stage', stage)),
              stage = 'lost', updated_at = now()
        where (bulk_listing_id = $1 or counterpart_id = $1) and stage = any($2::text[])
        returning id`,
      [id, LIVE_OFFER_STAGES]);
    // The Story note below says why; skip the trigger's bare "Closed · reason" row.
    await tx.query("set local bulk.skip_status_activity = 'on'");
    await tx.query(
      `update crm_bulk_listings
          set status = 'closed', closed_reason = $2, updated_at = now(),
              context = context || jsonb_build_object('abandoned', jsonb_build_object('at', now(), 'by', $3::text, 'from_status', status))
        where id = $1`,
      [id, reason, actor.email]);
    const label = abandonReasonLabel(listing.kind, reason);
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data)
       values ($1, 'note', $2, $3, $4::uuid, $5::jsonb)`,
      [id, `Abandoned: ${label}`, note || null, actor.userId,
        JSON.stringify({ abandoned: true, reason, previous_status: listing.status, offers_lost: offers.rows.map((row) => row.id) })]);
    return "ok";
  });
}

/** Dragged out of Abandoned: reopens the listing as it was before (open or qualifying) and puts back the offers the
 * abandon marked lost. A listing closed elsewhere (no context.abandoned) reopens as open and has no offers to restore. */
export async function reopenListing(id: string, actor: Actor): Promise<ReopenResult> {
  return withPgTransaction(async (tx) => {
    const found = await tx.query<{ status: string; from_status: string | null }>(
      "select status, context->'abandoned'->>'from_status' as from_status from crm_bulk_listings where id = $1 for update", [id]);
    const listing = found.rows[0];
    if (!listing) return "missing";
    if (listing.status !== "closed") return "open";
    const status = listing.from_status === "qualifying" ? "qualifying" : "open";
    const offers = await tx.query(
      `update crm_bulk_offers
          set stage = data->'abandoned'->>'stage', data = data - 'abandoned', updated_at = now()
        where (bulk_listing_id = $1 or counterpart_id = $1) and stage = 'lost' and data->'abandoned'->>'listing_id' = $1
        returning id`,
      [id]);
    await tx.query("set local bulk.skip_status_activity = 'on'");
    await tx.query(
      "update crm_bulk_listings set status = $2, closed_reason = null, context = context - 'abandoned', updated_at = now() where id = $1",
      [id, status]);
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data)
       values ($1, 'note', 'Reopened from Abandoned', null, $2::uuid, $3::jsonb)`,
      [id, actor.userId, JSON.stringify({ reopened: true, status, offers_restored: offers.rows.map((row) => row.id) })]);
    return "ok";
  });
}
