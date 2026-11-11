import "server-only";
import { readFileSync, statSync } from "node:fs";
import { queryPg } from "./postgres";
import { julesReply, parseJulesWatch, type JulesMail, type JulesReply, type JulesWatch } from "./relay-jules-core";

/**
 * Replies to Jules, the server part: reads the notes of the Hermes job that takes sellers' answers into their listings
 * and says, for each thread, what became of their newest email. Read only: the job owns the file.
 */

const WATCH_FILE = process.env.RELAY_JULES_REPLIES || "/root/.hermes/workspace/jules-follow-ups/production/replies.json";
let watchCache: { mtime: number; watch: JulesWatch } | null = null;

/** The job's notes, read again only when the file has changed. A file caught half written keeps the last good read;
 * no file means no notes. */
function julesWatch(): { watch: JulesWatch; checkedAt: string } | null {
  let mtime: number;
  try { mtime = statSync(WATCH_FILE).mtimeMs; } catch { watchCache = null; return null; }
  if (watchCache?.mtime !== mtime) {
    try {
      const watch = parseJulesWatch(JSON.parse(readFileSync(WATCH_FILE, "utf8")));
      if (watch) watchCache = { mtime, watch };
    } catch { /* read again on the next ask */ }
  }
  return watchCache ? { watch: watchCache.watch, checkedAt: new Date(watchCache.mtime).toISOString() } : null;
}

/** By mail thread: what the job made of their newest email. Threads that are not answers to Jules are left out, and
 * so are threads where an email has gone out since: the row is about that email by then. */
export async function julesReplies(threadIds: string[]): Promise<Map<string, JulesReply>> {
  const read = julesWatch();
  if (!read || !threadIds.length) return new Map();
  // The job reads mail sent to the inbox (not copied to it) in the order it arrived (created_at, id), so both are asked the same way.
  const rows = await queryPg<JulesMail & { thread_id: string; answered: boolean }>(
    `select distinct on (m.thread_id) m.thread_id::text as thread_id, m.id, m.subject, m.in_reply_to, m.rfc_references, m.has_attachments,
       coalesce(m.to_emails,'{}') || array[coalesce(m.recipient_email,'')] as "to",
       coalesce((m.created_at, m.id) > ($2::timestamptz, $3::text), false) as unread,
       exists (select 1 from mail_message o where o.direction = 'outbound' and o.rfc_message_id = m.in_reply_to) as ours,
       exists (select 1 from mail_message o where o.thread_id = m.thread_id and o.direction = 'outbound'
         and o.sent_at > coalesce(m.sent_at, m.accepted_at, m.created_at)) as answered
     from mail_message m where m.thread_id::text = any($1) and m.direction = 'inbound'
     order by m.thread_id, coalesce(m.sent_at, m.accepted_at, m.created_at) desc`,
    [threadIds, read.watch.cursor?.[0] ?? null, read.watch.cursor?.[1] ?? null]);
  const out = new Map<string, JulesReply>();
  for (const { thread_id, answered, ...mail } of rows) {
    const reply = answered ? null : julesReply(mail, read.watch, read.checkedAt);
    if (reply) out.set(thread_id, reply);
  }
  return out;
}
