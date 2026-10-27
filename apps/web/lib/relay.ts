import "server-only";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { queryPg, withPgTransaction } from "./postgres";
import { draftAttachments, readMailDraft } from "./crm-postgres/mail";
import { editDraft, identitySignatures, textToHtml, splitCopy } from "./mail-draft-actions";
import type { DraftAttachment } from "./mail-types";
import { amountsIn } from "./relay-checks";

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
  } | null;
};

export type RelayTodo = { id: string; item_id: string | null; title: string; detail: string; kind: "suggested" | "promise" | "manual"; state: string; reb_key: string | null; source: string | null; created_at: string };
/** What the "Before you send" note checks a draft against: amounts seen in the thread, deal and note; everyone on the thread; the deal's price unit. */
export type RelayFacts = { amounts: string[]; participants: string[]; unit: "cell" | "kwh" | null };
export type RelayReviewItem = RelayItem & { drafts: RelayDraftView[]; todos: RelayTodo[]; facts: RelayFacts };


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
       (select count(*) from relay_todo t where t.owner_id = $1::uuid and t.state = 'accepted')::int as todos,
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
- Greet by first name ("Hi Mark,"), sign off "Best,\\nAlex". Do not add a signature block; it is added automatically.
- No em dashes. British English.
Return ONLY JSON:
{"subject": "Re: …" (keep the thread's subject), "body": "the reply text",
 "follow_ons": [ {"title": "short action, e.g. Book Qube for Thursday", "why": "one line", "to": "email address or empty if unknown", "subject": "…", "body": "…"} ] (0-3 other emails Alex should send because of this reply, only when clearly implied by his note or the thread; empty list otherwise),
 "todos": [ {"title": "short task", "detail": "due or context, one line", "kind": "suggested" | "promise"} ] (0-3; include as kind "promise" anything this reply commits Alex to),
 "log": ["2-4 short past-tense lines of what you did, e.g. Read the thread and the deal"]}`;

export type DraftResult = { item: RelayItem };

/** Turns the owner's note into draft v1 (plus follow-ons and to-dos) and moves the item to Review. */
export async function draftFromNote(itemId: string, ownerId: string, note: string): Promise<RelayItem> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  if (!note.trim()) throw new RelayError(400, "Add a note first: how do you want to reply?");
  await updateRelayItem(itemId, ownerId, { note });
  const messages = await threadMessages(item.mail_thread_id);
  const rules = (await listRules(ownerId)).map((r) => r.text);
  const deal = await dealSummary(item.bulk_listing_id);
  const lastInbound = messages.find((m) => m.direction === "inbound");
  const transcript = [...messages].reverse().map((m) => `--- ${m.direction === "inbound" ? `From ${m.from_email}` : `From Alex (${m.from_email})`} · ${m.at}\nTo: ${m.to_emails.join(", ")}${m.cc_emails.length ? `\nCc: ${m.cc_emails.join(", ")}` : ""}\nSubject: ${m.subject ?? ""}\n${stripQuoted(m.body_text ?? "").slice(0, 3000)}`).join("\n\n");
  const prompt = `Alex's note (what he wants to say):\n${note}\n\n${item.tab === "follow" ? "This is a FOLLOW-UP: Alex wrote last and got no reply. Write a short, friendly chase.\n\n" : ""}Thread (oldest first):\n${transcript || `${item.headline}\n${item.context}\n${item.last_message?.text ?? ""}`}\n\n${deal ? `Linked deal record:\n${deal}\n\n` : ""}Reply to: ${lastInbound?.from_email ?? item.counterpart_email ?? ""}`;
  const parsed = parseJson(await askAgent(DRAFT_SYSTEM(rules), prompt));
  const identity = replyIdentity(messages);
  const to = (lastInbound?.from_email ?? item.counterpart_email ?? "").trim();
  if (!to) throw new RelayError(400, "Relay couldn't find who to reply to on this thread.");
  const subject = String(parsed.subject || messages[0]?.subject || item.headline || "").slice(0, 300) || "Re:";
  const body = String(parsed.body ?? "").trim();
  if (!body) throw new RelayError(502, "The assistant returned an empty draft. Try again.");
  const log = Array.isArray(parsed.log) ? parsed.log.filter((l): l is string => typeof l === "string").slice(0, 4) : [];
  const primaryId = await createMailDraft({ identity, to: [to], ccThread: true, thread: item.mail_thread_id, subject, body });
  const followOns = Array.isArray(parsed.follow_ons) ? (parsed.follow_ons as Record<string, unknown>[]).slice(0, 3) : [];
  const todos = Array.isArray(parsed.todos) ? (parsed.todos as Record<string, unknown>[]).slice(0, 3) : [];
  const followRows: { title: string; why: string; mailId: string | null }[] = [];
  for (const f of followOns) {
    const fTo = typeof f.to === "string" && /@/.test(f.to) ? f.to.trim() : "";
    const fBody = String(f.body ?? "").trim();
    if (!fBody) continue;
    // A follow-on with no known recipient is kept as a draft to a placeholder the owner must replace.
    const mailId = fTo ? await createMailDraft({ identity: "alex", to: [fTo], ccThread: false, thread: null, subject: String(f.subject ?? f.title ?? "").slice(0, 300) || "(no subject)", body: fBody }).catch(() => null) : null;
    followRows.push({ title: String(f.title ?? "Follow-on email").slice(0, 120), why: String(f.why ?? "").slice(0, 200), mailId });
  }
  await withPgTransaction(async (tx) => {
    await tx.query("update relay_draft set state = 'skipped', updated_at = now() where item_id = $1 and state = 'draft'", [itemId]);
    await tx.query(`insert into relay_draft (item_id, role, position, title, why, mail_message_id, source_note, agent_log) values ($1, 'primary', 0, $2, '', $3, $4, $5::jsonb)`,
      [itemId, `Reply to ${item.counterpart_name ?? to}`, primaryId, note, JSON.stringify(log)]);
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
  return (await readRelayItem(itemId, ownerId))!;
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
  const signatures = await identitySignatures();
  const items = await queryPg<RelayItem>(`select ${ITEM_COLUMNS} from relay_item i where i.owner_id = $1::uuid and i.status = 'review' order by i.updated_at asc`, [ownerId]);
  if (!items.length) return [];
  const ids = items.map((i) => i.id);
  const drafts = await queryPg<DraftRow>(`select id,item_id,role,position,title,why,state,source_note,agent_log,mail_message_id,gmail_draft_id from relay_draft where item_id = any($1) and state <> 'skipped' order by position`, [ids]);
  const mailIds = drafts.map((d) => d.mail_message_id).filter((id): id is string => !!id);
  const mails = mailIds.length ? await queryPg<{ id: string; state: string; identity_key: string | null; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null; body_text: string | null; updated_at: string; personalization: { attachments?: unknown } | null; transport: string | null }>(
    `select id,state,identity_key,from_email,coalesce(to_emails,'{}') as to_emails,coalesce(cc_emails,'{}') as cc_emails,subject,body_text,updated_at,personalization,transport from mail_message where id = any($1)`, [mailIds]) : [];
  const byMail = new Map(mails.map((m) => [m.id, m]));
  const todos = await queryPg<RelayTodo>(`select t.id,t.item_id,t.title,t.detail,t.kind,t.state,w.reb_key,null as source,t.created_at from relay_todo t left join work_tasks w on w.id = t.work_task_id where t.item_id = any($1) and t.state in ('suggested','accepted') order by t.created_at`, [ids]);
  const facts = new Map<string, RelayFacts>();
  for (const item of items) {
    const messages = await threadMessages(item.mail_thread_id);
    const deal = await dealSummary(item.bulk_listing_id);
    const notes = drafts.filter((d) => d.item_id === item.id).map((d) => d.source_note).join("\n");
    const corpus = [deal, notes, item.context, item.last_message?.text ?? "", ...messages.map((m) => m.body_text ?? "")].join("\n");
    const participants = [...new Set(messages.flatMap((m) => [m.from_email ?? "", ...m.to_emails, ...m.cc_emails]).concat(item.counterpart_email ?? "")
      .map((a) => a.toLowerCase().trim()).filter((a) => a && !a.endsWith("@rebattery.io")))];
    const unit = /per[ -]cell|\/\s?cell|each cell/i.test(deal) ? "cell" : /kwh/i.test(deal) ? "kwh" : null;
    facts.set(item.id, { amounts: amountsIn(corpus), participants, unit });
  }
  return items.map((item) => ({
    ...item,
    facts: facts.get(item.id) ?? { amounts: [], participants: [], unit: null },
    drafts: drafts.filter((d) => d.item_id === item.id).map((d) => {
      const m = d.mail_message_id ? byMail.get(d.mail_message_id) : undefined;
      const sent = m && m.state !== "draft" && m.state !== "frozen";
      return {
        id: d.id, role: d.role, position: d.position, title: d.title, why: d.why, state: sent ? "sent" : d.state, source_note: d.source_note,
        agent_log: Array.isArray(d.agent_log) ? (d.agent_log as unknown[]).filter((l): l is string => typeof l === "string") : [],
        mail_message_id: d.mail_message_id, gmail_draft_id: d.gmail_draft_id,
        mail: m ? { id: m.id, state: m.state, identity_key: m.identity_key, from_email: m.from_email, to_emails: m.to_emails, cc_emails: m.cc_emails, subject: m.subject,
          main: splitCopy(m.body_text, signatures.get(m.identity_key ?? "") ?? null).main, updated_at: m.updated_at, attachments: draftAttachments(m.personalization?.attachments), transport: m.transport } : null,
      };
    }),
    todos: todos.filter((t) => t.item_id === item.id),
  }));
}

/** When every draft of an item is sent or skipped, the item is done. */
export async function settleItem(itemId: string): Promise<void> {
  await queryPg(`update relay_draft d set state = 'sent', updated_at = now() from mail_message m
    where d.item_id = $1 and m.id = d.mail_message_id and d.state in ('draft','gmail') and m.state not in ('draft','frozen')`, [itemId]);
  await queryPg(`update relay_item set status = 'done', done_reason = 'sent', updated_at = now() where id = $1 and status = 'review'
    and not exists (select 1 from relay_draft where item_id = $1 and role = 'primary' and state in ('draft','gmail'))`, [itemId]);
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
  const current = mail.body_text ?? "";
  const system = `You edit one email draft for Alex Polglase (ReBattery) exactly as instructed. Keep facts unchanged unless told. Follow these rules:\n${rules.map((r) => `- ${r}`).join("\n")}\nNo signature block. Return ONLY JSON {"body": "the full new email text", "note": "one short line saying what you changed"}.`;
  const parsed = parseJson(await askAgent(system, `Instruction: ${instruction}\n\nCurrent draft:\n${current}`, 120_000));
  const body = String(parsed.body ?? "").trim();
  if (!body) throw new RelayError(502, "The assistant returned an empty draft. Try again.");
  await editDraft(mail, { body });
  return { body, note: String(parsed.note ?? "Updated the draft.").slice(0, 200) };
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
  const [m] = await queryPg<{ subject: string | null; body_html: string | null; body_text: string | null; to_emails: string[]; cc_emails: string[]; from_email: string | null; personalization: { reply_gmail_message_id?: string } | null; state: string }>(
    "select subject, body_html, body_text, coalesce(to_emails,'{}') as to_emails, coalesce(cc_emails,'{}') as cc_emails, from_email, personalization, state from mail_message where id = $1", [relayDraft.mail_message_id]);
  if (!m) throw new RelayError(404, "Not found");
  if (m.state !== "draft") throw new RelayError(409, "This email was already sent.");
  const args = ["--account", "alex@rebattery.io", "--gmail-no-send", "--enable-commands-exact", "gmail.drafts.create", "--no-input", "--json",
    "gmail", "drafts", "create", "--subject", m.subject ?? "", "--body", m.body_text ?? "", "--body-html", m.body_html ?? textToHtml(m.body_text ?? "")];
  if (m.to_emails.length) args.push("--to", m.to_emails.join(","));
  if (m.cc_emails.length) args.push("--cc", m.cc_emails.join(","));
  if (m.from_email && m.from_email !== "alex@rebattery.io") args.push("--from", m.from_email);
  if (m.personalization?.reply_gmail_message_id) args.push("--reply-to-message-id", m.personalization.reply_gmail_message_id);
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

// ---------- chat ----------

export async function relayChatKey(itemId: string, userId: string): Promise<string | null> {
  const [row] = await queryPg<{ conversation_key: string }>("select conversation_key from relay_chat where item_id = $1 and user_id = $2::uuid", [itemId, userId]);
  return row?.conversation_key ?? null;
}

export async function saveRelayChat(itemId: string, userId: string, key: string): Promise<void> {
  await queryPg(`insert into relay_chat (item_id, user_id, conversation_key) values ($1, $2::uuid, $3)
    on conflict (item_id, user_id) do update set conversation_key = excluded.conversation_key, created_at = now()`, [itemId, userId, key]);
}
