import { queryPg, withPgTransaction } from "../postgres";
import type { DealOwner } from "../bulk-owner";

/** Sets the one-line next action (and optional due date, and optionally the driver) of a demand or supply listing in one statement. Null clears it. */
export async function setListingNext(id: string, next: { next_action: string | null; next_due: string | null; owner?: DealOwner }): Promise<boolean> {
  const rows = await queryPg(
    `update crm_bulk_listings set next_action = $2, next_due = $3::date,
            context = case when $4::text is null then context else jsonb_set(context, '{owner}', to_jsonb($4::text)) end,
            updated_at = now()
     where id = $1 and kind in ('demand', 'supply') returning id`,
    [id, next.next_action, next.next_due, next.owner ?? null],
  );
  return rows.length > 0;
}

export type CompleteNext = {
  /** The action that was done, as the user saw it. */
  done: string;
  next_action: string | null;
  next_due: string | null;
  /** Set the driver in the same step (a listing with no driver needs one so the action reaches someone). */
  owner?: DealOwner;
};

/**
 * Marks the current next action done and sets the next one in one step: a Story note "Done: ..." and the new action.
 * Only completes the action the user saw: when the listing's action has changed since (another tab, a retried request),
 * nothing is written and it returns "conflict". "missing" when the listing does not exist.
 */
export async function completeListingNext(id: string, input: CompleteNext, actorUserId: string | null): Promise<"ok" | "missing" | "conflict"> {
  return withPgTransaction(async (tx) => {
    const { rows } = await tx.query<{ next_action: string | null; next_due: string | null }>(
      `select next_action, to_char(next_due, 'YYYY-MM-DD') as next_due from crm_bulk_listings
        where id = $1 and kind in ('demand', 'supply') for update`, [id]);
    const current = rows[0];
    if (!current) return "missing";
    if (current.next_action !== input.done) return "conflict";
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data, actor_user_id)
       values ($1, 'note', $2, $3::jsonb, $4)`,
      [id, `Done: ${input.done}`.slice(0, 320), JSON.stringify({ next_done: input.done, was_due: current.next_due, next_action: input.next_action, next_due: input.next_due }), actorUserId]);
    await tx.query(
      `update crm_bulk_listings
          set next_action = $2, next_due = $3::date,
              context = case when $4::text is null then context else jsonb_set(context, '{owner}', to_jsonb($4::text)) end,
              updated_at = now()
        where id = $1`,
      [id, input.next_action, input.next_action ? input.next_due : null, input.owner ?? null]);
    return "ok";
  });
}
