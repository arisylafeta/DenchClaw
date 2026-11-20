import "server-only";
import { AUTO_NOTE } from "./relay-auto-note";
import { listWaiting } from "./relay-rank";
import { draftFromNote, RelayError } from "./relay";
import { queryPg } from "./postgres";

/** How many replies one run writes, and when it stops starting new ones, so a run ends well before the next. */
const PER_RUN = 6;
const RUN_BUDGET_MS = 12 * 60_000;

export type PrepareResult = { drafted: { itemId: string; name: string }[]; failed: { itemId: string; name: string; why: string }[]; skipped: number };

/**
 * Writes Relay's first reply, ahead of time, for the people at the top of "Waiting on you" (Now and Today) who have none,
 * so the email opens with a draft and Relay's prices in. Never sends. One at a time, best first; an email with an unsent
 * draft or a running job is left alone.
 */
export async function prepareDrafts(ownerId: string): Promise<PrepareResult> {
  const started = Date.now();
  const view = await listWaiting(ownerId);
  const rows = [...view.bands.now, ...view.bands.today].filter((r) => !r.hasDraft);
  const ids = rows.map((r) => r.openId);
  const busy = new Set((await queryPg<{ id: string }>(
    `select i.id from relay_item i where i.id = any($1) and (
       exists (select 1 from relay_draft d where d.item_id = i.id and d.state in ('draft', 'gmail'))
       or exists (select 1 from relay_job j where j.item_id = i.id and j.status in ('queued', 'running', 'ready', 'finalising')))`, [ids])).map((r) => r.id));
  const result: PrepareResult = { drafted: [], failed: [], skipped: 0 };
  for (const row of rows) {
    if (busy.has(row.openId)) { result.skipped++; continue; }
    if (result.drafted.length + result.failed.length >= PER_RUN || Date.now() - started > RUN_BUDGET_MS) break;
    try {
      await draftFromNote(row.openId, ownerId, AUTO_NOTE, "quick");
      result.drafted.push({ itemId: row.openId, name: row.name });
    } catch (error) {
      if (!(error instanceof RelayError)) console.error("relay prepare", row.openId, error);
      result.failed.push({ itemId: row.openId, name: row.name, why: error instanceof Error ? error.message : "failed" });
    }
  }
  return result;
}
