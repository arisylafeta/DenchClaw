import { guardRelay, relayError } from "@/lib/relay-route";
import { listScheduled, listSenderRules, listTasks, listRelayItems, listReview, listRules, relayCounts, RELAY_TABS, type RelayTab } from "@/lib/relay";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One call for the whole page: counts, the requested tab's items, review, to-dos, rules, and when the scan last ran and read Gmail. */
export async function GET(req: Request) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const tabParam = new URL(req.url).searchParams.get("tab") as RelayTab | null;
  const tab = tabParam && RELAY_TABS.includes(tabParam) ? tabParam : "action";
  try {
    const id = guard.user.id;
    const [counts, items, review, todos, scheduled, rules, senderRules, scan] = await Promise.all([
      relayCounts(id), listRelayItems(id, tab), listReview(id), listTasks(guard.user), listScheduled(guard.user), listRules(id), listSenderRules(id),
      queryPg<{ finished_at: string | null; mail_synced_at: string | null }>("select finished_at::text, mail_synced_at::text from relay_scan_run where owner_id = $1::uuid", [id]),
    ]);
    const [learnRun] = await queryPg<{ ran_at: string; sent: number; unchanged: number; edited: number; proposed: number; note: string }>(
      "select ran_at::text, sent, unchanged, edited, proposed, note from relay_learn_run where owner_id = $1::uuid order by ran_at desc limit 1", [id]).catch(() => []);
    const [voice] = await queryPg<{ version: number; created_at: string; source_emails: number | null; eval: Record<string, unknown> | null; guide: string }>(
      "select version, created_at::text, source_emails, eval, guide from relay_voice where owner_id = $1::uuid and active", [id]).catch(() => []);
    const [avg] = await queryPg<{ minutes: number | null }>(
      `select avg(extract(epoch from (coalesce(d.sent_at, d.updated_at) - coalesce(i.waiting_since, i.created_at))) / 60)::int as minutes
       from relay_draft d join relay_item i on i.id = d.item_id where i.owner_id = $1::uuid and d.state = 'sent' and coalesce(d.sent_at, d.updated_at) > now() - interval '7 days'`, [id]);
    return Response.json({ tab, counts, items, review, todos, scheduled, rules, senderRules, learnRun: learnRun ?? null, voice: voice ?? null, scannedAt: scan[0]?.finished_at ?? null, mailSyncedAt: scan[0]?.mail_synced_at ?? null, avgReplyMinutes: avg?.minutes ?? null });
  } catch (error) {
    return relayError(error);
  }
}
