import "server-only";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { queryPg, withPgTransaction } from "./postgres";
import { draftAttachments, readMailDraft } from "./crm-postgres/mail";
import { editDraft, editableCopy, identitySignatures, sameVersion, textToHtml, splitCopy } from "./mail-draft-actions";
import type { DraftAttachment } from "./mail-types";
import { amountsIn, NEEDS_AGENT } from "./relay-checks";

const run = promisify(execFile);
const MAIL_CLI = "/usr/local/bin/rebattery-mail";
const KEYRING_PASSWORD_FILE = "/root/.hermes/workspace/.secrets/gog-keyring-password";

export const RELAY_TABS = ["action", "follow", "other"] as const;
export type RelayTab = (typeof RELAY_TABS)[number];
export type RelayPriority = "urgent" | "overdue" | "high" | "medium" | "low";

export type RelayMessage = { from_name: string | null; from_email: string | null; at: string | null; direction: string | null; text: string };
export type RelayEarlier = { who: string; when: string; summary: string };

export type RelayItem = {
  id: string;
  tab: RelayTab;
  status: "open" | "review" | "done";
  priority: RelayPriority;
  counterpart_name: string | null;
  counterpart_email: string | null;
  company: string | null;
  contact_type: string | null;
  headline: string;
  context: string;
  last_message: RelayMessage | null;
  earlier: RelayEarlier[];
  bulk_listing_id: string | null;
  deal_label: string | null;
  waiting_since: string | null;
  note: string;
  mail_thread_id: string | null;
  gmail_thread_id: string;
  updated_at: string;
};

export type RelayDraftView = {
  id: string;
  role: "primary" | "follow";
  position: number;
  title: string;
  why: string;
  state: "draft" | "gmail" | "sent" | "skipped";
  source_note: string;
  agent_log: string[];
  mail_message_id: string | null;
  gmail_draft_id: string | null;
  mail: {
    id: string; state: string; identity_key: string | null; from_email: string | null; to_emails: string[]; cc_emails: string[];
    subject: string | null; main: string; updated_at: string; attachments: DraftAttachment[]; transport: string | null;
    /** Why the last send attempt did not go out, if it didn't. */
    failure: { reason: string; detail?: unknown } | null;
  } | null;
};

export type RelayTodo = { id: string; item_id: string | null; title: string; detail: string; kind: "suggested" | "promise" | "manual"; state: string; reb_key: string | null; source: string | null; created_at: string };
/** What the "Before you send" note checks a draft against: amounts seen in the thread, deal and note; everyone on the thread; the deal's price unit. */
export type RelayFacts = { amounts: string[]; participants: string[]; unit: "cell" | "kwh" | null };
export type RelayReviewItem = RelayItem & { drafts: RelayDraftView[]; todos: RelayTodo[]; facts: RelayFacts; job: RelayJob | null };


const ITEM_COLUMNS = `i.id,i.tab,i.status,i.priority,i.counterpart_name,i.counterpart_email,i.company,i.contact_type,i.headline,i.context,i.last_message,
  i.earlier,i.bulk_listing_id,i.deal_label,i.waiting_since,i.note,i.mail_thread_id,i.gmail_thread_id,i.updated_at`;

const PRIORITY_ORDER = `case i.priority when 'urgent' then 0 when 'overdue' then 1 when 'high' then 2 when 'medium' then 3 else 4 end`;

/** Items waiting on the owner, by tab, most important first. Snoozed items stay hidden until their time comes. */
export async function listRelayItems(ownerId: string, tab: RelayTab): Promise<RelayItem[]> {
  return queryPg<RelayItem>(
    `select ${ITEM_COLUMNS} from relay_item i
     where i.owner_id = $1::uuid and i.status = 'open' and i.tab = $2 and (i.snooze_until is null or i.snooze_until <= now())
     order by ${PRIORITY_ORDER}, coalesce(i.waiting_since, i.updated_at) asc limit 200`, [ownerId, tab]);
}

export type RelayCounts = { action: number; follow: number; other: number; review: number; todos: number; sent_today: number; done_today: number };

export async function relayCounts(ownerId: string): Promise<RelayCounts> {
  const [row] = await queryPg<RelayCounts>(
    `select
       count(*) filter (where status = 'open' and tab = 'action' and (snooze_until is null or snooze_until <= now()))::int as action,
       count(*) filter (where status = 'open' and tab = 'follow' and (snooze_until is null or snooze_until <= now()))::int as follow,
       count(*) filter (where status = 'open' and tab = 'other' and (snooze_until is null or snooze_until <= now()))::int as other,
       count(*) filter (where status = 'review')::int as review,
       (select count(*) from work_tasks w left join relay_task_meta m on m.work_task_id = w.id
          where lower(w.assignee_email) = (select lower(email) from crm_users where id = $1::uuid) and w.status in ('Planned','In Progress')
          and (m.snooze_until is null or m.snooze_until <= now()))::int as todos,
       (select count(*) from relay_draft d join relay_item x on x.id = d.item_id where x.owner_id = $1::uuid and d.state = 'sent' and d.updated_at >= date_trunc('day', now()))::int as sent_today,
       count(*) filter (where status = 'done' and updated_at >= date_trunc('day', now()))::int as done_today
     from relay_item where owner_id = $1::uuid`, [ownerId]);
  return row ?? { action: 0, follow: 0, other: 0, review: 0, todos: 0, sent_today: 0, done_today: 0 };
}

export async function readRelayItem(id: string, ownerId: string): Promise<RelayItem | null> {
  const [row] = await queryPg<RelayItem>(`select ${ITEM_COLUMNS} from relay_item i where i.id = $1 and i.owner_id = $2::uuid`, [id, ownerId]);
  return row ?? null;
}

export type RelayItemPatch = { note?: string; status?: "open" | "done"; tab?: RelayTab; snooze_until?: string | null; done_reason?: string };

/** Saves the note, marks done (no reply needed), moves between tabs or snoozes. Only the owner's own items. */
export async function updateRelayItem(id: string, ownerId: string, patch: RelayItemPatch): Promise<RelayItem | null> {
  const sets: string[] = []; const values: unknown[] = [id, ownerId];
  const add = (column: string, value: unknown) => { values.push(value); sets.push(`${column} = $${values.length}`); };
  if (typeof patch.note === "string") add("note", patch.note.slice(0, 4000));
  if (patch.status) add("status", patch.status);
  if (patch.tab) add("tab", patch.tab);
  if (patch.snooze_until !== undefined) add("snooze_until", patch.snooze_until);
  if (typeof patch.done_reason === "string") add("done_reason", patch.done_reason.slice(0, 200));
  if (!sets.length) return readRelayItem(id, ownerId);
  await queryPg(`update relay_item set ${sets.join(", ")}, updated_at = now() where id = $1 and owner_id = $2::uuid`, values);
  return readRelayItem(id, ownerId);
}

// ---------- rules ----------

export const DEFAULT_RULES = [
  "Two to four short lines. Warm and direct.",
  "British English. No em dashes.",
  "Never offer a price to a dismantler or supplier: ask for theirs.",
  "Every number must come from the thread or the deal.",
];

export async function listRules(ownerId: string): Promise<{ id: string; text: string }[]> {
  const rows = await queryPg<{ id: string; text: string }>("select id, text from relay_rule where owner_id = $1::uuid order by position, created_at", [ownerId]);
  if (rows.length) return rows;
  await withPgTransaction(async (tx) => {
    for (const [position, text] of DEFAULT_RULES.entries()) {
      await tx.query("insert into relay_rule (owner_id, text, position) values ($1::uuid, $2, $3)", [ownerId, text, position]);
    }
  });
  return queryPg<{ id: string; text: string }>("select id, text from relay_rule where owner_id = $1::uuid order by position, created_at", [ownerId]);
}

export async function addRule(ownerId: string, text: string): Promise<void> {
  await queryPg("insert into relay_rule (owner_id, text, position) values ($1::uuid, $2, (select coalesce(max(position), 0) + 1 from relay_rule where owner_id = $1::uuid))", [ownerId, text.slice(0, 300)]);
}

export async function deleteRule(ownerId: string, id: string): Promise<void> {
  await queryPg("delete from relay_rule where id = $1 and owner_id = $2::uuid", [id, ownerId]);
}

// ---------- context for drafting ----------

type ThreadMessage = { id: string; direction: string; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null; body_text: string | null; at: string; identity_key: string | null; state: string };

async function threadMessages(mailThreadId: string | null): Promise<ThreadMessage[]> {
  if (!mailThreadId) return [];
  return queryPg<ThreadMessage>(
    `select id, direction, from_email, coalesce(to_emails,'{}') as to_emails, coalesce(cc_emails,'{}') as cc_emails, subject, body_text,
       coalesce(sent_at, accepted_at, created_at)::text as at, identity_key, state
     from mail_message where thread_id = $1 and state in ('received','accepted','sent','delivered','opened','clicked','replied')
     order by coalesce(sent_at, accepted_at, created_at) desc limit 8`, [mailThreadId]);
}

async function dealSummary(listingId: string | null): Promise<string> {
  if (!listingId) return "";
  const [row] = await queryPg<Record<string, unknown>>("select * from crm_bulk_listings where id = $1", [listingId]).catch(() => []);
  if (!row) return "";
  const keep = Object.entries(row).filter(([key, value]) => value !== null && value !== "" && !/(_at|_id|^id|match_hash)$/.test(key) && !(value instanceof Date)).slice(0, 40);
  return keep.map(([key, value]) => `${key}: ${(typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 400)}`).join("\n");
}

const stripQuoted = (text: string) => text.split(/\n(?:On .{5,120}wrote:|-{2,} ?Original Message|From: .+\nSent: )/)[0].replace(/\n>.*$/gm, "").trim();

function replyIdentity(messages: ThreadMessage[]): "alex" | "supply" {
  const latest = messages.find((m) => m.direction === "inbound") ?? messages[0];
  const addresses = [...(latest?.to_emails ?? []), ...(latest?.cc_emails ?? [])].map((a) => a.toLowerCase());
  if (latest?.identity_key === "supply" || addresses.includes("supply@rebattery.io")) return "supply";
  const sent = messages.find((m) => m.direction === "outbound");
  return sent?.identity_key === "supply" ? "supply" : "alex";
}

// ---------- the agent ----------

async function askAgent(system: string, user: string, timeoutMs = 240_000): Promise<string> {
  const base = process.env.HERMES_API_BASE_URL ?? "http://127.0.0.1:8642";
  const key = process.env.HERMES_API_KEY;
  if (!key) throw new RelayError(503, "The assistant is not configured here.");
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "hermes-agent", temperature: 0.3, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new RelayError(502, "The assistant did not answer. Try again.");
  return ((await response.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
}

function parseJson(content: string): Record<string, unknown> {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new RelayError(502, "The assistant's draft could not be read. Try again.");
  try { return JSON.parse(match[0]) as Record<string, unknown>; } catch { throw new RelayError(502, "The assistant's draft could not be read. Try again."); }
}

export class RelayError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const DRAFT_SYSTEM = (rules: string[]) => `You are Relay, drafting emails for Alex Polglase, founder of ReBattery (a UK marketplace and broker for used EV and storage batteries).
Write exactly what Alex asked for in his note, in his voice. Follow these writing rules strictly:
${rules.map((r) => `- ${r}`).join("\n")}
- Never invent facts: prices, quantities, dates, tests, partners, logistics or availability must come from the thread, the deal or Alex's note. Use a [BLANK] if something is missing.
- Nothing is attached to this draft. Never write that something is attached, enclosed or included as a file. If a file is needed, say you will send it, and add a to-do.
- Greet by first name ("Hi Mark,"), sign off "Best,\\nAlex". Do not add a signature block; it is added automatically.
- No em dashes. British English.
Return ONLY JSON:
{"subject": "Re: …" (keep the thread's subject), "body": "the reply text",
 "follow_ons": [ {"title": "short action, e.g. Book Qube for Thursday", "why": "one line", "to": "email address or empty if unknown", "subject": "…", "body": "…"} ] (0-3 other emails Alex should send because of this reply, only when clearly implied by his note or the thread; empty list otherwise),
 "todos": [ {"title": "short task", "detail": "due or context, one line", "kind": "suggested" | "promise"} ] (0-3; include as kind "promise" anything this reply commits Alex to),
 "log": ["2-4 short past-tense lines of what you did, e.g. Read the thread and the deal"]}`;

export type DraftResult = { item: RelayItem };

/** Everything a draft is written from: the thread, the deal, the writing rules and who the reply goes to. */
async function draftContext(item: RelayItem, ownerId: string, note: string) {
  const messages = await threadMessages(item.mail_thread_id);
  const rules = (await listRules(ownerId)).map((r) => r.text);
  const deal = await dealSummary(item.bulk_listing_id);
  const lastInbound = messages.find((m) => m.direction === "inbound");
  const transcript = [...messages].reverse().map((m) => `--- ${m.direction === "inbound" ? `From ${m.from_email}` : `From Alex (${m.from_email})`} · ${m.at}\nTo: ${m.to_emails.join(", ")}${m.cc_emails.length ? `\nCc: ${m.cc_emails.join(", ")}` : ""}\nSubject: ${m.subject ?? ""}\n${stripQuoted(m.body_text ?? "").slice(0, 3000)}`).join("\n\n");
  const prompt = `Alex's note (what he wants to say):\n${note}\n\n${item.tab === "follow" ? "This is a FOLLOW-UP: Alex wrote last and got no reply. Write a short, friendly chase.\n\n" : ""}Thread (oldest first):\n${transcript || `${item.headline}\n${item.context}\n${item.last_message?.text ?? ""}`}\n\n${deal ? `Linked deal record:\n${deal}\n\n` : ""}Reply to: ${lastInbound?.from_email ?? item.counterpart_email ?? ""}`;
  const to = (lastInbound?.from_email ?? item.counterpart_email ?? "").trim();
  if (!to) throw new RelayError(400, "Relay couldn't find who to reply to on this thread.");
  return { messages, rules, prompt, to, identity: replyIdentity(messages) };
}

/** Turns the owner's note into draft v1 (plus follow-ons and to-dos) and moves the item to Review. Notes that need work start an agent job instead. */
export async function draftFromNote(itemId: string, ownerId: string, note: string, mode: "auto" | "quick" = "auto"): Promise<RelayItem> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  if (!note.trim()) throw new RelayError(400, "Add a note first: how do you want to reply?");
  await updateRelayItem(itemId, ownerId, { note });
  if (mode === "auto" && NEEDS_AGENT.test(note)) {
    await startJob(item, ownerId, note);
    return (await readRelayItem(itemId, ownerId))!;
  }
  const ctx = await draftContext(item, ownerId, note);
  const parsed = parseJson(await askAgent(DRAFT_SYSTEM(ctx.rules), ctx.prompt));
  await saveDraftOutputs(item, ownerId, note, ctx, parsed, []);
  return (await readRelayItem(itemId, ownerId))!;
}

/** Writes the drafts, attaches files and saves to-dos for one item, then puts it in Review. Shared by quick drafts and agent jobs. */
async function saveDraftOutputs(item: RelayItem, ownerId: string, note: string, ctx: Awaited<ReturnType<typeof draftContext>>, parsed: Record<string, unknown>, files: string[]): Promise<void> {
  const itemId = item.id;
  const rawSubject = String(parsed.subject || ctx.messages[0]?.subject || item.headline || "").trim();
  const subject = (rawSubject.replace(/^((re|aw|fw|fwd)\s*:\s*)+/i, (m) => (/^(re|aw)/i.test(m) ? "Re: " : m)).slice(0, 300)) || "Re:";
  const body = String(parsed.body ?? "").trim();
  if (!body) throw new RelayError(502, "The assistant returned an empty draft. Try again.");
  const log = Array.isArray(parsed.log) ? parsed.log.filter((l): l is string => typeof l === "string").slice(0, 6) : [];
  const sources = Array.isArray(parsed.sources) ? parsed.sources.filter((l): l is string => typeof l === "string").slice(0, 6).map((l) => `Source: ${l}`) : [];
  const primaryId = await createMailDraft({ identity: ctx.identity, to: [ctx.to], ccThread: true, thread: item.mail_thread_id, subject, body });
  if (files.length) {
    try { await run(MAIL_CLI, ["attachment", "add", primaryId, ...files], { timeout: 60_000, maxBuffer: 4 << 20 }); }
    catch { log.push("Couldn't attach the files; attach them with Attach stock list or in Gmail"); }
  }
  const followOns = Array.isArray(parsed.follow_ons) ? (parsed.follow_ons as Record<string, unknown>[]).slice(0, 3) : [];
  const todos = Array.isArray(parsed.todos) ? (parsed.todos as Record<string, unknown>[]).slice(0, 3) : [];
  const followRows: { title: string; why: string; mailId: string | null }[] = [];
  for (const f of followOns) {
    const fTo = typeof f.to === "string" && /@/.test(f.to) ? f.to.trim() : "";
    const fBody = String(f.body ?? "").trim();
    if (!fBody) continue;
    // A follow-on with no known recipient has no draft yet; the card says so.
    const mailId = fTo ? await createMailDraft({ identity: "alex", to: [fTo], ccThread: false, thread: null, subject: String(f.subject ?? f.title ?? "").slice(0, 300) || "(no subject)", body: fBody }).catch(() => null) : null;
    followRows.push({ title: String(f.title ?? "Follow-on email").slice(0, 120), why: String(f.why ?? "").slice(0, 200), mailId });
  }
  await withPgTransaction(async (tx) => {
    await tx.query("update relay_draft set state = 'skipped', updated_at = now() where item_id = $1 and state in ('draft','gmail')", [itemId]);
    await tx.query(`insert into relay_draft (item_id, role, position, title, why, mail_message_id, source_note, agent_log) values ($1, 'primary', 0, $2, '', $3, $4, $5::jsonb)`,
      [itemId, `Reply to ${item.counterpart_name ?? ctx.to}`, primaryId, note, JSON.stringify([...log, ...sources])]);
    for (const [index, f] of followRows.entries()) {
      await tx.query(`insert into relay_draft (item_id, role, position, title, why, mail_message_id, source_note) values ($1, 'follow', $2, $3, $4, $5, $6)`,
        [itemId, index + 1, f.title, f.why, f.mailId, note]);
    }
    await tx.query("delete from relay_todo where item_id = $1 and state = 'suggested'", [itemId]);
    for (const t of todos) {
      const title = String(t.title ?? "").trim().slice(0, 160);
      if (!title) continue;
      await tx.query("insert into relay_todo (item_id, owner_id, title, detail, kind) values ($1, $5::uuid, $2, $3, $4)",
        [itemId, title, String(t.detail ?? "").slice(0, 200), t.kind === "promise" ? "promise" : "suggested", ownerId]);
    }
    await tx.query("update relay_item set status = 'review', updated_at = now() where id = $1", [itemId]);
  });
}

// ---------- agent jobs ----------

const JOB_ROOT = "/srv/rebattery-data/relay-jobs";
const JOB_RUNNER = "/root/denchclaw/scripts-live/scripts/rebattery/relay_job.py";
const JOB_STALE_MINUTES = 25;
export type RelayJob = { id: string; item_id: string; status: "queued" | "running" | "ready" | "finalising" | "done" | "failed"; steps: string[]; error: string | null; created_at: string; started_at: string | null; finished_at: string | null; note: string };

const JOB_SYSTEM = (rules: string[], dir: string) => `You are Relay, Alex Polglase's email agent at ReBattery (a UK marketplace and broker for used EV and storage batteries).
Alex's note asks for work before a reply can be written. Do the work with your tools, then write the reply.

What you may do:
- Read the CRM database read-only: psql -X -A -d denchclaw -c "<select ...>" (tables include crm_stock_opportunities, crm_bulk_listings, crm_people, crm_companies, mail_message). SELECT only.
- Build a buyer stock list with the fixed builder, never by hand: /usr/bin/python3 /root/denchclaw/scripts-live/scripts/rebattery/stock_list.py --out "${dir}/ReBattery stock - <scope> - <D Mon YYYY>.xlsx" [--chemistry LFP,NMC] [--type pack,module,cell,container] [--make ...] [--countries ...] [--min-kwh N] [--prices --currency GBP|EUR]. Run with --dry-run first to see counts. Prices only if Alex's note asks for them.
- Read skills and files for context. Write files ONLY inside ${dir}.

What you must never do: send, draft, edit or label any email (no rebattery-mail draft/edit/send, no gog gmail), write to any database, contact anyone, or name a supplier, town or stock ref in the email.

Writing rules for the reply:
${rules.map((r) => `- ${r}`).join("\n")}
- Every number in the email must come from the thread, the deal, Alex's note or your research (list where in "sources").
- Only say a file is attached if it is in "files". Greet by first name, sign off "Best,\\nAlex", no signature block, no em dashes, British English.

Finish with ONLY this JSON as your final message:
{"subject": "Re: …", "body": "the reply", "files": ["absolute paths of files you made in ${dir} to attach"], "sources": ["one line per fact you used, e.g. CRM stock: 76 LFP lots, 19,454 kWh"], "todos": [{"title": "…", "detail": "…", "kind": "suggested" | "promise"}], "follow_ons": [], "log": ["3-6 short past-tense lines of what you did"]}`;

/** Queues an agent job for the note and starts the runner. The item moves to Review straight away and shows progress there. */
async function startJob(item: RelayItem, ownerId: string, note: string): Promise<void> {
  const ctx = await draftContext(item, ownerId, note);
  const [job] = await queryPg<{ id: string }>("insert into relay_job (item_id, owner_id, note, steps) values ($1, $2::uuid, $3, $4::jsonb) returning id",
    [item.id, ownerId, note, JSON.stringify(["Queued"])]);
  const dir = join(JOB_ROOT, job.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "prompt.txt"), `${JOB_SYSTEM(ctx.rules, dir)}\n\n${ctx.prompt}`, { mode: 0o600 });
  await withPgTransaction(async (tx) => {
    await tx.query("update relay_draft set state = 'skipped', updated_at = now() where item_id = $1 and state in ('draft','gmail')", [item.id]);
    await tx.query("update relay_item set status = 'review', updated_at = now() where id = $1", [item.id]);
  });
  const child = spawn("/usr/bin/python3", [JOB_RUNNER, job.id], { detached: true, stdio: "ignore" });
  child.unref();
}

/** Runs the item's last agent job again with the same note. */
export async function retryJob(itemId: string, ownerId: string): Promise<void> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  const [last] = await queryPg<{ note: string; status: string }>("select note, status from relay_job where item_id = $1 order by created_at desc limit 1", [itemId]);
  if (!last) throw new RelayError(404, "Nothing to retry.");
  if (["queued", "running", "finalising"].includes(last.status)) throw new RelayError(409, "Relay is still working on this.");
  await startJob(item, ownerId, last.note);
}

/** Latest job per item in Review. Jobs stuck past the time limit are marked failed. */
export async function jobsFor(itemIds: string[]): Promise<Map<string, RelayJob>> {
  if (!itemIds.length) return new Map();
  await queryPg(`update relay_job set status = 'failed', error = 'Timed out', finished_at = now()
    where item_id = any($1) and status in ('queued','running','finalising') and created_at < now() - ($2 || ' minutes')::interval`, [itemIds, String(JOB_STALE_MINUTES)]);
  const rows = await queryPg<RelayJob>(`select distinct on (item_id) id, item_id, status, steps, error, created_at, started_at, finished_at, note
    from relay_job where item_id = any($1) order by item_id, created_at desc`, [itemIds]);
  return new Map(rows.map((r) => [r.item_id, r]));
}

/** Turns finished agent results into drafts. Runs when Relay loads; each job is claimed once. */
export async function finaliseJobs(ownerId: string): Promise<void> {
  const claimed = await queryPg<{ id: string; item_id: string; note: string; result: Record<string, unknown> }>(
    `update relay_job set status = 'finalising' where owner_id = $1::uuid and status = 'ready' returning id, item_id, note, result`, [ownerId]);
  for (const job of claimed) {
    try {
      const item = await readRelayItem(job.item_id, ownerId);
      if (!item) throw new Error("Email no longer in Relay");
      const dir = realpathSync(join(JOB_ROOT, job.id));
      const files = (Array.isArray(job.result.files) ? job.result.files : []).filter((f): f is string => typeof f === "string").flatMap((f) => {
        try {
          const real = realpathSync(f);
          return real.startsWith(`${dir}/`) && /\.(xlsx|csv|pdf|docx)$/i.test(real) && statSync(real).size < 10 << 20 ? [real] : [];
        } catch { return []; }
      });
      const ctx = await draftContext(item, ownerId, job.note);
      await saveDraftOutputs(item, ownerId, job.note, ctx, job.result, files);
      await queryPg("update relay_job set status = 'done', finished_at = now(), steps = steps || $2::jsonb where id = $1", [job.id, JSON.stringify(["Draft ready"])]);
    } catch (error) {
      await queryPg("update relay_job set status = 'failed', error = $2, finished_at = now() where id = $1", [job.id, (error instanceof Error ? error.message : "Couldn't save the draft").slice(0, 300)]);
    }
  }
}

type NewDraft = { identity: "alex" | "supply"; to: string[]; ccThread: boolean; thread: string | null; subject: string; body: string };

/** Creates a mail_message draft through the mail CLI, so threading, the identity signature and content policy apply. */
async function createMailDraft(d: NewDraft): Promise<string> {
  const args = ["draft", "--identity", d.identity, "--transport", "gmail", "--purpose", "personal", "--to", d.to.join(","),
    `--subject=${d.subject}`, `--body=${d.body}`, `--html=${textToHtml(d.body)}`];
  if (d.thread) args.push("--thread", d.thread);
  if (d.thread && d.ccThread) args.push("--cc-thread");
  args.push("--apply");
  try {
    const { stdout } = await run(MAIL_CLI, args, { timeout: 90_000, maxBuffer: 8 << 20 });
    const id = (JSON.parse(stdout) as { message?: { id?: string }; id?: string }).message?.id;
    if (!id) throw new Error("no id");
    return id;
  } catch (error) {
    const out = (error as { stdout?: string }).stdout ?? "";
    try { const parsed = JSON.parse(out) as { refused?: string }; if (parsed.refused) throw new RelayError(409, `The mail tool refused the draft: ${parsed.refused}`); } catch (inner) { if (inner instanceof RelayError) throw inner; }
    throw new RelayError(502, "Couldn't save the draft. Try again.");
  }
}

// ---------- review ----------

type DraftRow = { id: string; item_id: string; role: "primary" | "follow"; position: number; title: string; why: string; state: RelayDraftView["state"]; source_note: string; agent_log: unknown; mail_message_id: string | null; gmail_draft_id: string | null };

/** Items in Review with their drafts (read live from mail_message) and suggested to-dos. */
export async function listReview(ownerId: string): Promise<RelayReviewItem[]> {
  await finaliseJobs(ownerId);
  const signatures = await identitySignatures();
  const items = await queryPg<RelayItem>(`select ${ITEM_COLUMNS} from relay_item i where i.owner_id = $1::uuid and i.status = 'review' order by i.updated_at asc`, [ownerId]);
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const drafts = await queryPg<DraftRow>(`select id,item_id,role,position,title,why,state,source_note,agent_log,mail_message_id,gmail_draft_id from relay_draft where item_id = any($1) and state <> 'skipped' order by position`, [ids]);
  const mailIds = drafts.map((d) => d.mail_message_id).filter((id): id is string => !!id);
  const mails = mailIds.length ? await queryPg<{ id: string; state: string; identity_key: string | null; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null; body_text: string | null; updated_at: string; personalization: { attachments?: unknown; send_failure?: { reason: string; detail?: unknown } } | null; transport: string | null }>(
    `select id,state,identity_key,from_email,coalesce(to_emails,'{}') as to_emails,coalesce(cc_emails,'{}') as cc_emails,subject,body_text,updated_at,personalization,transport from mail_message where id = any($1)`, [mailIds]) : [];
  const byMail = new Map(mails.map((m) => [m.id, m]));
  const todos = await queryPg<RelayTodo>(`select t.id,t.item_id,t.title,t.detail,t.kind,t.state,w.reb_key,null as source,t.created_at from relay_todo t left join work_tasks w on w.id = t.work_task_id where t.item_id = any($1) and t.state in ('suggested','accepted') order by t.created_at`, [ids]);
  const facts = new Map<string, RelayFacts>();
  for (const item of items) {
    const messages = await threadMessages(item.mail_thread_id);
    const deal = await dealSummary(item.bulk_listing_id);
    const notes = drafts.filter((d) => d.item_id === item.id).map((d) => `${d.source_note}\n${Array.isArray(d.agent_log) ? (d.agent_log as unknown[]).join("\n") : ""}`).join("\n");
    const corpus = [deal, notes, item.context, item.last_message?.text ?? "", ...messages.map((m) => m.body_text ?? "")].join("\n");
    const participants = [...new Set(messages.flatMap((m) => [m.from_email ?? "", ...m.to_emails, ...m.cc_emails]).concat(item.counterpart_email ?? "")
      .map((a) => a.toLowerCase().trim()).filter((a) => a && !a.endsWith("@rebattery.io")))];
    const unit = /per[ -]cell|\/\s?cell|each cell/i.test(deal) ? "cell" : /kwh/i.test(deal) ? "kwh" : null;
    facts.set(item.id, { amounts: amountsIn(corpus), participants, unit });
  }
  const jobs = await jobsFor(ids);
  const settled = await settleItems(ids);
  return items.filter((item) => !settled.has(item.id)).map((item) => ({
    ...item,
    job: jobs.get(item.id) ?? null,
    facts: facts.get(item.id) ?? { amounts: [], participants: [], unit: null },
    drafts: drafts.filter((d) => d.item_id === item.id).map((d) => {
      const m = d.mail_message_id ? byMail.get(d.mail_message_id) : undefined;
      const sent = m?.state === "accepted";
      return {
        id: d.id, role: d.role, position: d.position, title: d.title, why: d.why, state: sent ? "sent" : d.state, source_note: d.source_note,
        agent_log: Array.isArray(d.agent_log) ? (d.agent_log as unknown[]).filter((l): l is string => typeof l === "string") : [],
        mail_message_id: d.mail_message_id, gmail_draft_id: d.gmail_draft_id,
        mail: m ? { id: m.id, state: m.state, identity_key: m.identity_key, from_email: m.from_email, to_emails: m.to_emails, cc_emails: m.cc_emails, subject: m.subject,
          main: splitCopy(m.body_text, signatures.get(m.identity_key ?? "") ?? null).main, updated_at: m.updated_at, attachments: draftAttachments(m.personalization?.attachments), transport: m.transport,
          failure: m.personalization?.send_failure ?? null } : null,
      };
    }),
    todos: todos.filter((t) => t.item_id === item.id),
  }));
}

/** Drafts Gmail accepted are sent; an item whose primary reply is sent is done. Returns the items that just closed. */
export async function settleItems(itemIds: string[]): Promise<Set<string>> {
  if (!itemIds.length) return new Set();
  await queryPg(`update relay_draft d set state = 'sent', updated_at = now() from mail_message m
    where d.item_id = any($1) and m.id = d.mail_message_id and d.state in ('draft','gmail') and m.state = 'accepted'`, [itemIds]);
  const closed = await queryPg<{ id: string }>(`update relay_item i set status = 'done', done_reason = 'sent', updated_at = now()
    where i.id = any($1) and i.status = 'review'
      and exists (select 1 from relay_draft d where d.item_id = i.id and d.role = 'primary' and d.state = 'sent')
      and not exists (select 1 from relay_draft d where d.item_id = i.id and d.role = 'primary' and d.state in ('draft','gmail'))
    returning i.id`, [itemIds]);
  return new Set(closed.map((r) => r.id));
}

// ---------- sending ----------

const SEND_RUNNER = "/root/denchclaw/scripts-live/scripts/rebattery/relay_send.py";

/**
 * Starts the send of the exact version Alex confirmed, detached from the request: the mail CLI's own gates run
 * (approval digest, reply check, suppression, one claim per message) and it records the outcome on the message.
 * Nothing here can kill a send half way, so a send is never left "maybe sent" by a web timeout.
 */
export async function queueSend(draftId: string, owner: { id: string; email: string }, updatedAt: string): Promise<void> {
  const relayDraft = await relayDraftForOwner(draftId, owner.id);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  const mail = await readMailDraft(relayDraft.mail_message_id, owner.id);
  if (!mail) throw new RelayError(404, "Not found");
  if (mail.state !== "draft") throw new RelayError(409, mail.state === "accepted" ? "Already sent." : "A send is already in progress or needs checking.");
  if (!sameVersion(mail.updated_at, updatedAt)) throw new RelayError(409, "This draft changed since you opened it. Reload to see the latest.");
  if (!mail.to_emails.length) throw new RelayError(400, "Add a recipient before sending.");
  const child = spawn("/usr/bin/python3", [SEND_RUNNER, mail.id, owner.email], { detached: true, stdio: "ignore" });
  child.unref();
}

/** "Check if it went": looks for the email in Gmail Sent; marks it sent, or returns it to a draft that can be sent again. */
export async function settleStuckSend(draftId: string, ownerId: string): Promise<{ outcome: "sent" | "released" | "wait"; retry_after_seconds?: number }> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  try {
    const { stdout } = await run(MAIL_CLI, ["release", "--apply", relayDraft.mail_message_id], { timeout: 120_000, maxBuffer: 4 << 20 });
    return JSON.parse(stdout.slice(stdout.indexOf("{"))) as { outcome: "sent" | "released" | "wait"; retry_after_seconds?: number };
  } catch {
    throw new RelayError(502, "Couldn't check Gmail just now. Try again in a minute.");
  }
}

export async function relayDraftForOwner(draftId: string, ownerId: string): Promise<(DraftRow & { owner_ok: boolean; mail_thread_id: string | null }) | null> {
  const [row] = await queryPg<DraftRow & { owner_ok: boolean; mail_thread_id: string | null }>(
    `select d.id,d.item_id,d.role,d.position,d.title,d.why,d.state,d.source_note,d.agent_log,d.mail_message_id,d.gmail_draft_id, true as owner_ok, i.mail_thread_id
     from relay_draft d join relay_item i on i.id = d.item_id where d.id = $1 and i.owner_id = $2::uuid`, [draftId, ownerId]);
  return row ?? null;
}

export async function setDraftState(draftId: string, state: RelayDraftView["state"], gmailDraftId?: string | null): Promise<void> {
  await queryPg("update relay_draft set state = $2, gmail_draft_id = coalesce($3, gmail_draft_id), updated_at = now() where id = $1", [draftId, state, gmailDraftId ?? null]);
}

// ---------- AI edits ----------

/** Rewrites a draft's main copy as instructed (shorter, warmer, "mention Thursday"), then saves it through the mail CLI. */
export async function rewriteDraft(draftId: string, ownerId: string, instruction: string): Promise<{ body: string; note: string }> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  const mail = await readMailDraft(relayDraft.mail_message_id, ownerId);
  if (!mail || mail.state !== "draft") throw new RelayError(409, "This email was already sent.");
  const rules = (await listRules(ownerId)).map((r) => r.text);
  const current = (await editableCopy(mail)).main;
  const files = (mail.attachments ?? []).map((a) => a.filename);
  const attachedLine = files.length ? `Files actually attached: ${files.join(", ")}. Only these may be called attached.` : "No files are attached. Never write that anything is attached, enclosed or included; if asked to attach something, say in the note that it needs the Attach stock list button or Gmail.";
  const system = `You edit one email draft for Alex Polglase (ReBattery) exactly as instructed. You can only change the text: you cannot attach files, run searches or do anything outside this email. Keep facts unchanged unless told. ${attachedLine} Follow these rules:\n${rules.map((r) => `- ${r}`).join("\n")}\nNo signature block. Return ONLY JSON {"body": "the full new email text", "note": "one short line saying what you changed, and plainly what you could not do"}.`;
  const parsed = parseJson(await askAgent(system, `Instruction: ${instruction}\n\nCurrent draft:\n${current}`, 120_000));
  const body = String(parsed.body ?? "").trim();
  if (!body) throw new RelayError(502, "The assistant returned an empty draft. Try again.");
  if (!files.length && claimsAttachment(body) && !claimsAttachment(current)) {
    throw new RelayError(422, "I can't attach files from here, so I didn't change the email. Use Attach stock list, or add the file in Gmail.");
  }
  await editDraft(mail, { body });
  return { body, note: String(parsed.note ?? "Updated the draft.").slice(0, 200) };
}

const claimsAttachment = (text: string) => /\b(attached|enclosed|attaching|i've attached|please find)\b/i.test(text);

// ---------- stock lists ----------

const STOCK_LIST = "/root/denchclaw/scripts-live/scripts/rebattery/stock_list.py";
export type StockFilters = { chemistry: string[]; types: string[]; makes: string[]; minKwh: number | null; countries: string[]; prices: boolean; currency: "GBP" | "EUR" };
export type StockSummary = { file: string; rows: number; total_kwh: number; by_type: Record<string, number>; by_country: Record<string, number>; excluded: Record<string, number>; gaps: unknown[] };

const CHEMS: [RegExp, string][] = [[/\blfp\b|lifepo/i, "LFP"], [/\bnmc\b|\bncm\b/i, "NMC"], [/\bnca\b/i, "NCA"], [/\blto\b/i, "LTO"]];
const TYPES: [RegExp, string][] = [[/\bpacks?\b/i, "pack"], [/\bmodules?\b/i, "module"], [/\bcells?\b/i, "cell"], [/\bcontainers?\b|\bbess\b|\bcabinets?\b/i, "container"]];
const MAKES = ["Volkswagen", "Skoda", "Audi", "Cupra", "Tesla", "Nissan", "Renault", "Hyundai", "Kia", "BMW", "Mercedes", "Jaguar", "Porsche", "MG", "BYD", "Stellantis", "Peugeot", "Fiat", "Toyota", "Volvo", "Polestar", "Ford", "CATL", "LG", "Samsung", "Panasonic"];

/** First guess at the list a buyer wants, from Alex's note and their latest email. Alex confirms or changes it. */
export async function suggestStockFilters(draftId: string, ownerId: string): Promise<StockFilters> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft) throw new RelayError(404, "Not found");
  const [item] = await queryPg<{ context: string; last_text: string | null; note: string }>(
    "select context, last_message->>'text' as last_text, note from relay_item where id = $1", [relayDraft.item_id]);
  const text = `${relayDraft.source_note} ${item?.note ?? ""} ${item?.last_text ?? ""} ${item?.context ?? ""}`;
  return {
    chemistry: CHEMS.filter(([re]) => re.test(text)).map(([, v]) => v),
    types: TYPES.filter(([re]) => re.test(text)).map(([, v]) => v),
    makes: MAKES.filter((m) => new RegExp(`\\b${m}\\b`, "i").test(text)),
    minKwh: null, countries: [], prices: false, currency: /€|eur\b/i.test(text) ? "EUR" : "GBP",
  };
}

/** Builds the buyer stock list (Excel, fixed columns, supplier details stripped) and attaches it to the draft. */
export async function attachStockList(draftId: string, ownerId: string, f: StockFilters): Promise<StockSummary> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  const label = [...f.chemistry, ...f.makes, ...f.types.map((t) => `${t}s`)].join(" ").trim() || "available";
  const day = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const dir = mkdtempSync(join(tmpdir(), "relay-stock-"));
  const out = join(dir, `ReBattery stock - ${label.replace(/[^\w .-]/g, "")} - ${day}.xlsx`);
  const args = [STOCK_LIST, "--out", out, "--title", `ReBattery stock - ${label}`];
  if (f.chemistry.length) args.push("--chemistry", f.chemistry.join(","));
  if (f.types.length) args.push("--type", f.types.join(","));
  if (f.makes.length) args.push("--make", f.makes.join(","));
  if (f.countries.length) args.push("--countries", f.countries.join(","));
  if (f.minKwh != null) args.push("--min-kwh", String(f.minKwh));
  if (f.prices) args.push("--prices", "--currency", f.currency);
  try {
    let summary: StockSummary;
    try {
      const { stdout } = await run("/usr/bin/python3", args, { timeout: 120_000, maxBuffer: 8 << 20 });
      summary = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as StockSummary;
    } catch (error) {
      const code = (error as { code?: number }).code;
      throw new RelayError(code === 2 ? 422 : 502, code === 2 ? "The stock list failed its privacy check (a supplier detail slipped in), so nothing was attached." : "Couldn't build the stock list. Try again.");
    }
    if (!summary.rows) throw new RelayError(404, "No stock matches those filters. Widen them and try again.");
    try {
      await run(MAIL_CLI, ["attachment", "add", relayDraft.mail_message_id, out], { timeout: 60_000, maxBuffer: 4 << 20 });
    } catch {
      throw new RelayError(502, "Built the list but couldn't attach it to the draft. Try again.");
    }
    return summary;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Removes an attachment from an unsent draft. */
export async function detachFile(draftId: string, ownerId: string, sha256: string): Promise<void> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  try {
    await run(MAIL_CLI, ["attachment", "remove", relayDraft.mail_message_id, sha256], { timeout: 60_000 });
  } catch {
    throw new RelayError(409, "Couldn't remove it. The email may already be sent.");
  }
}

// ---------- Gmail drafts ----------

function gogEnv(): NodeJS.ProcessEnv {
  if (process.env.GOG_KEYRING_PASSWORD) return process.env;
  try { return { ...process.env, GOG_KEYRING_PASSWORD: readFileSync(process.env.GOG_KEYRING_PASSWORD_FILE || KEYRING_PASSWORD_FILE, "utf8").trim() }; } catch { return process.env; }
}

/** Copies a Relay draft into Alex's Gmail drafts, threaded as a reply, for further editing there. Gmail sending stays blocked. */
export async function saveToGmailDrafts(draftId: string, ownerId: string): Promise<{ gmailDraftId: string | null }> {
  const relayDraft = await relayDraftForOwner(draftId, ownerId);
  if (!relayDraft?.mail_message_id) throw new RelayError(404, "Not found");
  const [m] = await queryPg<{ subject: string | null; body_html: string | null; body_text: string | null; to_emails: string[]; cc_emails: string[]; from_email: string | null; personalization: { reply_gmail_message_id?: string; attachments?: { storedPath?: string }[] } | null; state: string }>(
    "select subject, body_html, body_text, coalesce(to_emails,'{}') as to_emails, coalesce(cc_emails,'{}') as cc_emails, from_email, personalization, state from mail_message where id = $1", [relayDraft.mail_message_id]);
  if (!m) throw new RelayError(404, "Not found");
  if (m.state !== "draft") throw new RelayError(409, "This email was already sent.");
  const args = ["--account", "alex@rebattery.io", "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create", "--no-input", "--json",
    "gmail", "drafts", "create", "--subject", m.subject ?? "", "--body", m.body_text ?? "", "--body-html", m.body_html ?? textToHtml(m.body_text ?? "")];
  if (m.to_emails.length) args.push("--to", m.to_emails.join(","));
  if (m.cc_emails.length) args.push("--cc", m.cc_emails.join(","));
  if (m.from_email && m.from_email !== "alex@rebattery.io") args.push("--from", m.from_email);
  if (m.personalization?.reply_gmail_message_id) args.push("--reply-to-message-id", m.personalization.reply_gmail_message_id);
  for (const file of m.personalization?.attachments ?? []) if (file.storedPath) args.push("--attach", file.storedPath);
  try {
    const { stdout } = await run(process.env.GOG_BIN || "gog", args, { env: gogEnv(), timeout: 60_000, maxBuffer: 4 << 20 });
    const parsed = JSON.parse(stdout) as { draftId?: string; id?: string; draft?: { id?: string } };
    const gmailDraftId = parsed.draftId ?? parsed.draft?.id ?? parsed.id ?? null;
    await setDraftState(draftId, "gmail", gmailDraftId);
    return { gmailDraftId };
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(502, "Gmail didn't accept the draft. Check that alex@ is connected.");
  }
}

/** Done = no reply needed: marks the thread read and labels it "4 Sorted" in Gmail. It stays in the Gmail inbox. */
export async function markDone(itemId: string, ownerId: string, ownerEmail: string): Promise<RelayItem | null> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  const args = ["--account", ownerEmail, "--gmail-no-send", "--enable-commands-exact", "gmail.thread.modify", "--no-input", "--json",
    "gmail", "thread", "modify", item.gmail_thread_id, "--remove", "UNREAD,1 Action,3 Follow up", "--add", "4 Sorted"];
  try {
    await run(process.env.GOG_BIN || "gog", args, { env: gogEnv(), timeout: 60_000, maxBuffer: 4 << 20 });
  } catch {
    throw new RelayError(502, "Gmail didn't accept the change. Try again.");
  }
  await queryPg("update relay_draft set state = 'skipped', updated_at = now() where item_id = $1 and state in ('draft','gmail')", [itemId]);
  return updateRelayItem(itemId, ownerId, { status: "done", done_reason: "user_done" });
}

// ---------- access ----------

/** Relay is Alex's alone for now: the page, the nav item and every route check this. */
export const RELAY_OWNER_EMAIL = "alex@rebattery.io";
export const canUseRelay = (email: string | null | undefined) => (email ?? "").toLowerCase() === RELAY_OWNER_EMAIL;

// ---------- to-dos ----------

/** Accepts a suggested to-do: creates a Work Task (next REB key) in the Backlog project, assigned to the owner. */
export async function acceptTodo(todoId: string, owner: { id: string; email: string }): Promise<{ reb_key: string }> {
  return withPgTransaction(async (tx) => {
    const { rows: [todo] } = await tx.query<{ id: string; title: string; detail: string; state: string; item_id: string | null; headline: string | null; counterpart_name: string | null }>(
      `select t.id, t.title, t.detail, t.state, t.item_id, i.headline, i.counterpart_name from relay_todo t left join relay_item i on i.id = t.item_id
       where t.id = $1 and t.owner_id = $2::uuid for update of t`, [todoId, owner.id]);
    if (!todo) throw new RelayError(404, "Not found");
    if (todo.state !== "suggested") throw new RelayError(409, "Already handled.");
    await tx.query("lock table work_tasks in share row exclusive mode");
    const { rows: [{ next }] } = await tx.query<{ next: number }>("select coalesce(max(substring(reb_key from '^REB-([0-9]+)$')::int), 0) + 1 as next from work_tasks");
    const rebKey = `REB-${next}`; const taskId = `reb-task-${next}`;
    const assignee = ["alex@rebattery.io", "ari@rebattery.io"].includes(owner.email.toLowerCase()) ? owner.email.toLowerCase() : null;
    const { rows: [project] } = await tx.query<{ id: string }>("select id from projects where id = 'reb-project-backlog' and status in ('Planned','In Progress')");
    let title = todo.title;
    const { rows: [dup] } = await tx.query("select 1 from work_tasks where lower(title) = lower($1)", [title]);
    if (dup) title = `${title} (${todo.counterpart_name ?? "Relay"})`;
    await tx.query(`insert into work_tasks (id, reb_key, title, status, project_id, priority, repository, task_details, assignee_email, assignee_id)
      values ($1, $2, $3, 'Planned', $4, 'Medium', 'runtime-only', $5, $6, $7::uuid)`,
      [taskId, rebKey, title, project?.id ?? null, `${todo.detail ? `${todo.detail}\n\n` : ""}${todo.item_id ? `From Relay: ${todo.counterpart_name ?? ""} · ${todo.headline ?? ""}` : "Added in Relay"}`.trim(), assignee, assignee ? owner.id : null]);
    await tx.query("update relay_todo set state = 'accepted', work_task_id = $2, updated_at = now() where id = $1", [todoId, taskId]);
    return { reb_key: rebKey };
  });
}

/** A promise Relay spotted in the draft ("I'll send the stock list"), added straight to the owner's to-dos. */
export async function addPromiseTodo(itemId: string, owner: { id: string; email: string }, title: string): Promise<{ reb_key: string }> {
  if (!await readRelayItem(itemId, owner.id)) throw new RelayError(404, "Not found");
  const [row] = await queryPg<{ id: string }>("insert into relay_todo (item_id, owner_id, title, detail, kind) values ($1, $3::uuid, $2, 'Promised in this email', 'promise') returning id", [itemId, title.slice(0, 160), owner.id]);
  return acceptTodo(row.id, owner);
}

/** A to-do Alex adds himself on the To-dos tab, not tied to an email. Becomes a Work Task straight away. */
export async function addTodo(owner: { id: string; email: string }, title: string, detail: string): Promise<{ reb_key: string }> {
  const [row] = await queryPg<{ id: string }>("insert into relay_todo (owner_id, title, detail, kind) values ($1::uuid, $2, $3, 'manual') returning id", [owner.id, title.slice(0, 160), detail.slice(0, 300)]);
  return acceptTodo(row.id, owner);
}

export async function setTodoState(todoId: string, ownerId: string, state: "dismissed" | "done"): Promise<void> {
  await queryPg(`update relay_todo set state = $3, updated_at = now() where id = $1 and owner_id = $2::uuid`, [todoId, ownerId, state]);
  if (state === "done") {
    await queryPg(`update work_tasks w set status = 'Done' from relay_todo t where t.id = $1 and w.id = t.work_task_id`, [todoId]);
  }
}

export async function listAcceptedTodos(ownerId: string): Promise<RelayTodo[]> {
  return queryPg<RelayTodo>(
    `select t.id, t.item_id, t.title, t.detail, t.kind, t.state, w.reb_key, coalesce(i.counterpart_name, i.counterpart_email) as source, t.created_at
     from relay_todo t left join relay_item i on i.id = t.item_id left join work_tasks w on w.id = t.work_task_id
     where t.owner_id = $1::uuid and t.state in ('accepted','done') order by t.state, t.created_at desc limit 200`, [ownerId]);
}

// ---------- to-dos (Work Tasks) ----------

export type RelayTask = {
  id: string; reb_key: string; title: string; status: string; created_at: string;
  category: "market" | "trade" | "ops" | "decide" | "mine" | "other";
  next_step: string; urgent_reason: string | null; due_at: string | null;
  question: string | null; yes_label: string | null; no_label: string | null;
  action_label: string | null; action_kind: "draft" | "open" | "none";
  link_kind: "mail" | "deal" | "shop" | "chat" | null; link_label: string | null;
  relay_item_id: string | null; bulk_listing_id: string | null; link_url: string | null; open_message_id: string | null;
  snooze_until: string | null;
};

/** Every open Work Task assigned to the owner, with Relay's notes on it. Snoozed tasks stay hidden until their time. */
export async function listTasks(owner: { id: string; email: string }): Promise<RelayTask[]> {
  return queryPg<RelayTask>(
    `select w.id, w.reb_key, w.status, w.created_at,
       coalesce(nullif(m.title,''), w.title) as title,
       case when t.kind = 'manual' then 'mine' else coalesce(m.category, 'other') end as category,
       coalesce(m.next_step, '') as next_step, m.urgent_reason, m.due_at::text as due_at, m.question, m.yes_label, m.no_label,
       m.action_label, coalesce(m.action_kind, 'none') as action_kind, m.link_kind, m.link_label,
       m.relay_item_id, m.bulk_listing_id, m.link_url, m.snooze_until,
       (select mm.id from mail_message mm where mm.thread_id = coalesce(m.mail_thread_id, ri.mail_thread_id)
          order by coalesce(mm.sent_at, mm.created_at) desc limit 1) as open_message_id
     from work_tasks w
     left join relay_task_meta m on m.work_task_id = w.id
     left join relay_item ri on ri.id = m.relay_item_id
     left join lateral (select kind from relay_todo where work_task_id = w.id limit 1) t on true
     where lower(w.assignee_email) = lower($1) and w.status in ('Planned', 'In Progress')
       and (m.snooze_until is null or m.snooze_until <= now())
     order by m.due_at nulls last, w.created_at asc limit 300`, [owner.email]);
}

async function ownTask(taskId: string, owner: { email: string }) {
  const [row] = await queryPg<{ id: string; status: string }>("select id, status from work_tasks where id = $1 and lower(assignee_email) = lower($2)", [taskId, owner.email]);
  if (!row) throw new RelayError(404, "Not found");
  return row;
}

/** Done, retire or snooze a task. Done and retire close the Work Task itself. */
export async function updateTask(taskId: string, owner: { id: string; email: string }, action: "done" | "retire" | "snooze" | "reopen", until?: string): Promise<void> {
  await ownTask(taskId, owner);
  if (action === "snooze") {
    const when = until ? new Date(until) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getTime() < Date.now()) throw new RelayError(400, "Pick a time in the future.");
    await queryPg(`insert into relay_task_meta (work_task_id, snooze_until) values ($1, $2)
      on conflict (work_task_id) do update set snooze_until = excluded.snooze_until, updated_at = now()`, [taskId, when.toISOString()]);
    return;
  }
  const status = action === "done" ? "Done" : action === "retire" ? "Retired" : "Planned";
  await queryPg("update work_tasks set status = $2, updated_at = now() where id = $1", [taskId, status]);
  await queryPg("update relay_todo set state = $2, updated_at = now() where work_task_id = $1", [taskId, action === "reopen" ? "accepted" : "done"]);
  if (action === "reopen") await queryPg("update relay_task_meta set snooze_until = null, updated_at = now() where work_task_id = $1", [taskId]);
}

/** "Draft in Relay": drafts the reply on the task's thread from its note, so it lands in Review (an agent job if it needs research or a list). */
export async function draftForTask(taskId: string, owner: { id: string; email: string }): Promise<{ itemId: string }> {
  await ownTask(taskId, owner);
  const [meta] = await queryPg<{ relay_item_id: string | null; mail_thread_id: string | null; action_note: string; next_step: string; title: string }>(
    "select relay_item_id, mail_thread_id, action_note, next_step, title from relay_task_meta where work_task_id = $1", [taskId]);
  if (!meta) throw new RelayError(409, "Relay hasn't read this task yet. Try again in a few minutes.");
  let itemId = meta.relay_item_id;
  if (!itemId && meta.mail_thread_id) {
    // The thread isn't in Relay yet: add it, using its latest inbound sender as the person.
    const [made] = await queryPg<{ id: string }>(
      `insert into relay_item (owner_id, gmail_thread_id, mail_thread_id, tab, status, headline, counterpart_email, counterpart_name)
       select $1::uuid, t.gmail_thread_id, t.id, 'action', 'open', $3,
         (select from_email from mail_message where thread_id = t.id and direction = 'inbound' order by coalesce(sent_at, created_at) desc limit 1),
         (select p.full_name from mail_message mm join crm_people p on lower(p.email) = lower(mm.from_email)
            where mm.thread_id = t.id and mm.direction = 'inbound' order by coalesce(mm.sent_at, mm.created_at) desc limit 1)
       from mail_thread t where t.id = $2
       on conflict (owner_id, gmail_thread_id) do update set updated_at = now()
       returning id`, [owner.id, meta.mail_thread_id, meta.title.slice(0, 200)]);
    itemId = made?.id ?? null;
    if (itemId) await queryPg("update relay_task_meta set relay_item_id = $2 where work_task_id = $1", [taskId, itemId]);
  }
  if (!itemId) throw new RelayError(409, "There's no email thread linked to this task to reply on.");
  await draftFromNote(itemId, owner.id, (meta.action_note || meta.next_step || meta.title).slice(0, 2000));
  return { itemId };
}

/** A to-do added on the To-dos tab: a Work Task in the Backlog, shown under "Added by you". */
export async function addTask(owner: { id: string; email: string }, title: string, dueLabel: string | null): Promise<{ reb_key: string }> {
  const created = await addTodo(owner, title, dueLabel ? `Due ${dueLabel}` : "");
  const [task] = await queryPg<{ id: string }>("select id from work_tasks where reb_key = $1", [created.reb_key]);
  if (task) {
    await queryPg(`insert into relay_task_meta (work_task_id, category, title, next_step, action_kind, classified_at) values ($1, 'mine', $2, $3, 'none', now())
      on conflict (work_task_id) do nothing`, [task.id, title.slice(0, 160), dueLabel ? `Due ${dueLabel}` : ""]);
  }
  return created;
}

// ---------- chat ----------

export async function relayChatKey(itemId: string, userId: string): Promise<string | null> {
  const [row] = await queryPg<{ conversation_key: string }>("select conversation_key from relay_chat where item_id = $1 and user_id = $2::uuid", [itemId, userId]);
  return row?.conversation_key ?? null;
}

export async function saveRelayChat(itemId: string, userId: string, key: string): Promise<void> {
  await queryPg(`insert into relay_chat (item_id, user_id, conversation_key) values ($1, $2::uuid, $3)
    on conflict (item_id, user_id) do update set conversation_key = excluded.conversation_key, created_at = now()`, [itemId, userId, key]);
}
