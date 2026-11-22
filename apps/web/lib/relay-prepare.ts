import "server-only";
import { AUTO_NOTE } from "./relay-auto-note";
import { listWaiting } from "./relay-rank";
import { draftFromNote, RelayError } from "./relay";
import { startDesk, waitForDesk } from "./relay-desk";
import { queryPg } from "./postgres";

/** How many replies one run writes, how many desk turns run at once, and when it stops starting new ones, so a run ends
 * well before the next. */
const PER_RUN = 6;
const AT_ONCE = 4;
const RUN_BUDGET_MS = 12 * 60_000;

export type PrepareResult = { drafted: { itemId: string; name: string }[]; failed: { itemId: string; name: string; why: string }[]; skipped: number };

type Row = { openId: string; name: string };

/**
 * Writes Relay's first reply, ahead of time, for the people at the top of "Waiting on you" (Now and Today) who have none,
 * so the email opens with a draft and Relay's prices in. Never sends. Each reply is a desk turn in mode "ahead" (the
 * email's own Claude Code session, which looks up what a good reply needs), best first, at most AT_ONCE at a time. When the
 * desk can't start, the one-shot draft is the fallback. An email with an unsent draft, a running job or a desk turn is
 * left alone.
 */
export async function prepareDrafts(ownerId: string): Promise<PrepareResult> {
  const started = Date.now();
  const view = await listWaiting(ownerId);
  const rows: Row[] = [...view.bands.now, ...view.bands.today].filter((r) => !r.hasDraft);
  const ids = rows.map((r) => r.openId);
  const busy = new Set((await queryPg<{ id: string }>(
    `select i.id from relay_item i where i.id = any($1) and (
       exists (select 1 from relay_draft d where d.item_id = i.id and d.state in ('draft', 'gmail'))
       or exists (select 1 from relay_job j where j.item_id = i.id and j.status in ('queued', 'running', 'ready', 'finalising'))
       or exists (select 1 from relay_desk_run r where r.item_id = i.id and r.status in ('queued', 'running', 'stopping')))`, [ids])).map((r) => r.id));
  const result: PrepareResult = { drafted: [], failed: [], skipped: 0 };
  const queue = rows.filter((r) => {
    if (busy.has(r.openId)) { result.skipped++; return false; }
    return true;
  }).slice(0, PER_RUN);

  const draftOne = async (row: Row) => {
    try {
      let run;
      try {
        run = await startDesk(row.openId, ownerId, "ahead", "");
      } catch (error) {
        // Only "the desk can't start" falls back; a turn already running (409) means the email is being worked on.
        if (!(error instanceof RelayError && error.status === 503)) throw error;
        await draftFromNote(row.openId, ownerId, AUTO_NOTE, "quick");
        result.drafted.push({ itemId: row.openId, name: row.name });
        return;
      }
      const status = await waitForDesk(run.id, "ahead");
      const [made] = await queryPg<{ id: string }>("select id from relay_draft where item_id = $1 and role = 'primary' and state in ('draft', 'gmail') limit 1", [row.openId]);
      if (status === "done" && made) result.drafted.push({ itemId: row.openId, name: row.name });
      else result.failed.push({ itemId: row.openId, name: row.name, why: status === "done" ? "The desk finished without a reply." : `The desk turn ${status}.` });
    } catch (error) {
      if (!(error instanceof RelayError)) console.error("relay prepare", row.openId, error);
      result.failed.push({ itemId: row.openId, name: row.name, why: error instanceof Error ? error.message : "failed" });
    }
  };

  // AT_ONCE workers each take the best email left; none starts a new one once the budget is spent.
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      if (Date.now() - started > RUN_BUDGET_MS) return;
      await draftOne(row);
    }
  }));
  return result;
}
