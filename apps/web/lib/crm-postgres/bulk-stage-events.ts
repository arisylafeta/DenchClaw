import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";

// Stage history for bulk listings and offers (crm_bulk_stage_events, migration 111). Triggers write every row, so a
// change made by the app, an agent or plain SQL is logged the same way. The app's only part is to say who is writing:
// the transaction's bulk.actor, here the signed-in user's email. Agents set it to their own name; without it the
// actor is 'system'.

export type StageEvent = {
  id: string;
  subject_kind: "listing" | "offer";
  subject_id: string;
  from_stage: string | null;
  to_stage: string | null;
  occurred_at: string;
  actor: string;
  note: string | null;
};

/** Runs `fn` in one transaction whose stage events name the signed-in user (by email), or 'system' without one. */
export async function asStageActor<T>(actorUserId: string | null, fn: (tx: PgTransaction) => Promise<T>): Promise<T> {
  return withPgTransaction(async (tx) => {
    await tx.query(
      `select set_config('bulk.actor', coalesce((select email from crm_users where id = $1::uuid), 'system'), true)`,
      [actorUserId]);
    return fn(tx);
  });
}

/** One listing's or offer's stage history, oldest first. */
export async function listStageEvents(subjectKind: StageEvent["subject_kind"], subjectId: string): Promise<StageEvent[]> {
  return queryPg<StageEvent>(
    `select id::text, subject_kind, subject_id, from_stage, to_stage, occurred_at::text, actor, note
     from crm_bulk_stage_events where subject_kind = $1 and subject_id = $2 order by occurred_at, id`, [subjectKind, subjectId]);
}
