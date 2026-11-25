import { withPgTransaction, type PgTransaction } from "../postgres";
import { abandonReasonLabel, isAbandonReason, LOSS_REASONS } from "../bulk-abandon";
import type { ListingKind } from "../bulk-listing";

/** Offer stages still in play. Abandoning a listing marks these (and unstaged counterparty offers) lost; paid, complete,
 * declined and lost stay as they are. */
const LIVE_OFFER_STAGES = ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced"];

export type AbandonResult = "ok" | "missing" | "closed" | "bad_reason";
export type ReopenResult = "ok" | "missing" | "open" | "not_abandoned";

type Actor = { userId: string | null; email: string | null };

/** The listing update without the status trigger's bare "Closed · reason" / "Opened" row: the caller writes its own note. */
async function quietListingUpdate(tx: PgTransaction, sql: string, params: unknown[]) {
  await tx.query("select set_config('bulk.skip_status_activity', 'on', true)");
  await tx.query(sql, params);
  await tx.query("select set_config('bulk.skip_status_activity', 'off', true)");
}

/**
 * Deals board, dragged to Abandoned: closes the listing with the reason (an existing closed_reason) and marks its live
 * counterparty offers lost, so a paired listing on the other side leaves the deal columns too. What it was is kept for a
 * reopen: context.abandoned on the listing ({at, by, from_status}) and data.abandoned on each offer ({listing_id, stage}).
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
        where (bulk_listing_id = $1 or counterpart_id = $1) and role = 'counterparty'
          and (stage = any($2::text[]) or stage is null)
        returning id`,
      [id, LIVE_OFFER_STAGES]);
    await quietListingUpdate(tx,
      `update crm_bulk_listings
          set status = 'closed', closed_reason = $2, updated_at = now(),
              context = context || jsonb_build_object('abandoned', jsonb_build_object('at', now(), 'by', $3::text, 'from_status', status))
        where id = $1`,
      [id, reason, actor.email]);
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data)
       values ($1, 'note', $2, $3, $4::uuid, $5::jsonb)`,
      [id, `Abandoned: ${abandonReasonLabel(listing.kind, reason)}`, note || null, actor.userId,
        JSON.stringify({ abandoned: true, reason, by: actor.email, previous_status: listing.status, offers_lost: offers.rows.map((row) => row.id) })]);
    return "ok";
  });
}

/**
 * Dragged out of Abandoned: reopens the listing as it was before (open or qualifying). Only listings in the Abandoned
 * column qualify: abandoned from the board, or closed elsewhere for a loss reason; never sold, duplicate or moved ones.
 * Offers an abandon marked lost come back to their old stage when the listing on their other side is not closed (a deal
 * between two abandoned listings revives when the second one reopens). The cleared reason is kept in the note.
 */
export async function reopenListing(id: string, actor: Actor): Promise<ReopenResult> {
  return withPgTransaction(async (tx) => {
    const found = await tx.query<{ kind: ListingKind; status: string; closed_reason: string | null; abandoned: boolean; from_status: string | null }>(
      `select kind, status, closed_reason, context ? 'abandoned' as abandoned, context->'abandoned'->>'from_status' as from_status
         from crm_bulk_listings where id = $1 for update`, [id]);
    const listing = found.rows[0];
    if (!listing) return "missing";
    if (listing.status !== "closed") return "open";
    if (!listing.abandoned && !(LOSS_REASONS as readonly string[]).includes(listing.closed_reason ?? "")) return "not_abandoned";
    const status = listing.from_status === "qualifying" ? "qualifying" : "open";
    await quietListingUpdate(tx,
      "update crm_bulk_listings set status = $2, closed_reason = null, context = context - 'abandoned', updated_at = now() where id = $1",
      [id, status]);
    const offers = await tx.query(
      `update crm_bulk_offers o
          set stage = o.data->'abandoned'->>'stage', data = o.data - 'abandoned', updated_at = now()
        where (o.bulk_listing_id = $1 or o.counterpart_id = $1) and o.stage = 'lost' and o.data ? 'abandoned'
          and not exists (select 1 from crm_bulk_listings other
            where other.id = case when o.bulk_listing_id = $1 then o.counterpart_id else o.bulk_listing_id end and other.status = 'closed')
        returning o.id`,
      [id]);
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, actor_user_id, data)
       values ($1, 'note', 'Reopened from Abandoned', $2, $3::uuid, $4::jsonb)`,
      [id, `Was closed as ${abandonReasonLabel(listing.kind, listing.closed_reason).toLowerCase()}.`, actor.userId,
        JSON.stringify({ reopened: true, by: actor.email, status, previous_reason: listing.closed_reason, offers_restored: offers.rows.map((row) => row.id) })]);
    return "ok";
  });
}
