import "server-only";
import { queryPg } from "./postgres";
import { readMailDraft } from "./crm-postgres/mail";
import { DraftActionError, identitySignatures, editDraft, sameVersion, splitCopy } from "./mail-draft-actions";
import {
  acceptTodo, activeGuide, activeRules, askAgent, cancelScheduledSend, createMailDraft, draftContext, queueSend, readRelayItem, RelayError, saveDraftBody,
  scheduleSend, startResearchJob, type RelayItem, type UnlessReply,
} from "./relay";
import { priceDraft, stockFits } from "./relay-price";
import { parseFills, unfilledGaps } from "./relay-price-core";
import type { PriceFill, StockFit } from "./relay-price-types";
import { threadSides, type GuardDraft } from "./relay-leak";
import { leaks, leakSentence, type Leak } from "./relay-leak-core";
import { sendAtProblem } from "./relay-send-time";
import type { PackSource } from "./relay-context-core";
import {
  hasPriceMarker, marks, parseTalk, pushHistory, readHistory, readSummary, SEND_MODES, stockBlock, TALK_ALL, talkPrompt, toKindOf,
  type HistoryEntry, type Mark, type ReadSummary, type SendMode, type TalkDraftIn, type TalkRole, type ToKind,
} from "./relay-talk-core";

/**
 * Relay's chat, the I/O part. Alex talks about one email's drafts; Relay reads everything (draftContext), answers with
 * edits and linked emails, and this module checks and applies them: the leak guard first, then the mail CLI through the
 * same saving path as an AI edit, with every earlier copy kept for Undo. Nothing here sends on its own: sendWithLinked
 * runs only on Alex's confirm, through queueSend and scheduleSend and their gap and leak guards.
 */

export type TalkTurn = { id: string; role: TalkRole; text: string; target: string; applied: TalkApplied | TraceApplied | null; created_at: string };

/** What a Relay turn did. blocked: a change that wasn't saved, and why (a leak, a scheduled send, the mail tool). */
export type TalkApplied = {
  edits: { draftId: string; title: string; reason: string; marks: Mark[] }[];
  added: { draftId: string; title: string; to: string; kind: string; sendMode: SendMode; sendAt: string | null; included: boolean }[];
  blocked: { draftId: string | null; title: string; why: string }[];
  todo: { id: string; title: string } | null;
  ruleOffer: { text: string; why: string } | null;
  research: { ask: string; started: boolean; why?: string } | null;
  prices: { draftId: string; fills: PriceFill[] }[];
  /** The leak guard's line when it checked a buyer's or a supplier's email this turn and found nothing. */
  guard: string | null;
};
/** A trace turn: what Relay read and how long it took. notes: what was dropped from the model's answer. */
export type TraceApplied = { ms: number; read: ReadSummary; notes: string[]; failed?: boolean };

/** One draft as the chat page shows it. change: the last change, which Undo takes back; undone: the one Redo puts back. */
export type TalkDraft = {
  id: string; role: "primary" | "follow"; position: number; title: string; why: string; state: "draft" | "gmail" | "sent";
  to_kind: ToKind; send_mode: SendMode; send_at: string | null; included: boolean;
  mail: {
    id: string; state: string; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null; main: string; updated_at: string;
    scheduled: { at: string; undo: boolean; unless_reply: boolean } | null; failure: { reason: string; detail?: unknown } | null;
  } | null;
  change: { reason: string; at: string; by: HistoryEntry["by"] } | null;
  undone: { reason: string; at: string } | null;
  marks: Mark[];
  leaks: Leak[];
  /** Relay's prices for the price gaps, or Alex's once he changed or accepted one. */
  fills: PriceFill[];
  /** A gap nothing fills yet: Send stays blocked. */
  gaps: boolean;
  price_markers: boolean;
};
export type TalkState = { turns: TalkTurn[]; drafts: TalkDraft[]; read: ReadSummary };

type Row = {
  id: string; item_id: string; role: "primary" | "follow"; position: number; title: string; why: string; state: string; to_kind: ToKind | null;
  send_mode: SendMode; send_at: string | null; included: boolean; history: unknown; redo: unknown; background: unknown; fills: unknown; mail_message_id: string | null;
  mail_state: string | null; identity_key: string | null; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null;
  body_text: string | null; updated_at: string | null; thread_id: string | null;
  scheduled: { at?: string; undo?: boolean; unless_reply?: unknown } | null; failure: { reason: string; detail?: unknown } | null;
};

/** The item's drafts that are still in play (not dropped), the reply first, with their mail. */
async function draftRows(itemId: string): Promise<Row[]> {
  return queryPg<Row>(
    `select d.id, d.item_id, d.role, d.position, d.title, d.why, d.state, d.to_kind, d.send_mode, d.send_at::text as send_at, d.included, d.history, d.redo,
       d.background, d.fills, d.mail_message_id, m.state as mail_state, m.identity_key, m.from_email, coalesce(m.to_emails, '{}') as to_emails,
       coalesce(m.cc_emails, '{}') as cc_emails, m.subject, m.body_text, m.updated_at, m.thread_id,
       m.personalization->'scheduled_send' as scheduled, m.personalization->'send_failure' as failure
     from relay_draft d left join mail_message m on m.id = d.mail_message_id
     where d.item_id = $1 and d.state <> 'skipped' order by d.role = 'primary' desc, d.position, d.created_at`, [itemId]);
}

const isSent = (r: Row) => r.state === "sent" || r.mail_state === "accepted" || (!!r.mail_state && r.mail_state !== "draft");
const guardOf = (r: Row, body?: string): GuardDraft => ({ id: r.id, role: r.role, to_kind: r.to_kind, to: r.to_emails, body: body ?? r.body_text ?? "" });

async function ownItem(itemId: string, ownerId: string): Promise<RelayItem> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  return item;
}

/** The drafts as the page shows them, each checked by the leak guard against everything on the thread. */
async function draftViews(item: RelayItem, ownerId: string, rows: Row[], stock: StockFit[]): Promise<TalkDraft[]> {
  const signatures = await identitySignatures();
  const withMail = rows.filter((r) => r.mail_message_id);
  const sides = await threadSides(item.id, ownerId, withMail.map((r) => guardOf(r)), stock);
  return rows.map((r) => {
    const main = splitCopy(r.body_text, signatures.get(r.identity_key ?? "") ?? null).main;
    const history = readHistory(r.history);
    const redo = readHistory(r.redo);
    const last = history[history.length - 1] ?? null;
    const toKind = sides.kinds.get(r.id) ?? r.to_kind ?? "other";
    const sent = isSent(r);
    return {
      id: r.id, role: r.role, position: r.position, title: r.title, why: r.why, state: sent ? "sent" : r.state === "gmail" ? "gmail" : "draft",
      to_kind: toKind, send_mode: r.send_mode, send_at: r.send_at, included: r.role === "primary" || r.included,
      mail: r.mail_message_id ? {
        id: r.mail_message_id, state: r.mail_state ?? "draft", from_email: r.from_email, to_emails: r.to_emails, cc_emails: r.cc_emails, subject: r.subject, main,
        updated_at: r.updated_at ?? "", failure: r.failure,
        scheduled: r.mail_state === "draft" && r.scheduled?.at ? { at: r.scheduled.at, undo: r.scheduled.undo === true, unless_reply: !!r.scheduled.unless_reply } : null,
      } : null,
      change: last ? { reason: last.reason, at: last.at, by: last.by } : null,
      undone: redo.length ? { reason: redo[redo.length - 1].reason, at: redo[redo.length - 1].at } : null,
      // Marks show the last change; after an Undo the page says "back to how it was" instead.
      marks: last && !redo.length && !sent ? marks(last.body, main) : [],
      leaks: r.body_text && !sent ? leaks({ toKind, body: r.body_text }, sides.facts) : [],
      fills: parseFills(r.fills),
      // Only gaps nothing fills: a price marker Relay or Alex has priced goes in at Send.
      gaps: unfilledGaps(main, parseFills(r.fills)).length > 0,
      price_markers: hasPriceMarker(main),
    };
  });
}

async function listTurns(itemId: string): Promise<TalkTurn[]> {
  return queryPg<TalkTurn>(
    `select * from (select id, role, text, target, applied, created_at::text as created_at from relay_talk where item_id = $1 order by created_at desc limit 200) t
     order by created_at`, [itemId]);
}

async function addTurn(itemId: string, ownerId: string, role: TalkRole, text: string, target: string, applied: TalkApplied | TraceApplied | null): Promise<void> {
  await queryPg("insert into relay_talk (item_id, owner_id, role, text, target, applied) values ($1, $2::uuid, $3, $4, $5, $6::jsonb)",
    [itemId, ownerId, role, text.slice(0, 4000), target, applied ? JSON.stringify(applied) : null]);
}

/** What Relay read for this email: the last turn's look-up, else the background stored with the reply when it was drafted. */
async function readFor(item: RelayItem, ownerId: string, rows: Row[], stock: StockFit[], sources?: PackSource[]): Promise<ReadSummary> {
  if (!sources) {
    const [last] = await queryPg<{ read: ReadSummary | null }>(
      `select applied->'read' as read from relay_talk where item_id = $1 and role = 'trace' and applied ? 'read'
         and not coalesce((applied->>'failed')::boolean, false) order by created_at desc limit 1`, [item.id]);
    if (last?.read) return last.read;
  }
  const stored = rows.find((r) => r.role === "primary")?.background;
  const background = sources ?? (Array.isArray(stored) ? (stored as PackSource[]).filter((s) => typeof s?.label === "string" && typeof s?.text === "string") : []);
  const [{ n }] = item.mail_thread_id ? await queryPg<{ n: number }>(
    "select count(*)::int as n from mail_message where thread_id = $1 and state in ('received','accepted','sent','delivered','opened','clicked','replied')", [item.mail_thread_id]) : [{ n: 0 }];
  const [rules, guide] = await Promise.all([activeRules(ownerId), activeGuide(ownerId)]);
  return readSummary({ sources: background, thread: n, deal: item.deal_label, stock, rules: rules.length, voice: !!guide });
}

/** GET: the chat so far, the drafts and what Relay has read. */
export async function talkState(itemId: string, ownerId: string): Promise<TalkState> {
  const item = await ownItem(itemId, ownerId);
  const [rows, stock, turns] = await Promise.all([draftRows(itemId), stockFits(itemId, ownerId), listTurns(itemId)]);
  return { turns, drafts: await draftViews(item, ownerId, rows, stock), read: await readFor(item, ownerId, rows, stock) };
}

const claimsAttachment = (text: string) => /\b(attached|enclosed|attaching|i've attached|please find)\b/i.test(text);
/** The words for a change Relay couldn't make. Anything other than a refusal is a real fault and is thrown on. */
const blockedWhy = (error: unknown) => {
  if (error instanceof RelayError || error instanceof DraftActionError) return error.message;
  throw error;
};

/**
 * One chat turn: builds the context, asks the model, reads its answer strictly and applies it. An edit keeps the old
 * copy in the draft's history and saves through the AI-edit path; a new email is created through the mail CLI as a
 * linked draft with its send mode. Every edited or new email passes the leak guard first; one that leaks isn't saved
 * and the turn says why. Then Relay prices the emails with price markers and starts any research asked for.
 */
export async function talk(itemId: string, owner: { id: string; email: string }, text: string, target: string): Promise<TalkState> {
  const item = await ownItem(itemId, owner.id);
  const rows = await draftRows(itemId);
  if (target !== TALK_ALL && !rows.some((r) => r.id === target)) throw new RelayError(400, "That draft isn't on this email.");
  const started = Date.now();
  await addTurn(itemId, owner.id, "alex", text, target, null);
  try {
    await answer(item, owner, rows, text, target, started);
  } catch (error) {
    const said = error instanceof RelayError || error instanceof DraftActionError ? error.message : "Something went wrong. Try again.";
    await addTurn(itemId, owner.id, "trace", said, target, { ms: Date.now() - started, read: { line: "", items: [] }, notes: [], failed: true });
    throw error;
  }
  return talkState(itemId, owner.id);
}

async function answer(item: RelayItem, owner: { id: string; email: string }, rows: Row[], text: string, target: string, started: number): Promise<void> {
  const signatures = await identitySignatures();
  const [ctx, stock, turns, asks] = await Promise.all([
    draftContext(item, owner.id, item.note.trim() || "(No note: Alex is working on the drafts with you in the chat.)", { offers: false }),
    stockFits(item.id, owner.id),
    queryPg<{ role: TalkRole; text: string; target: string }>(
      "select role, text, target from (select role, text, target, created_at from relay_talk where item_id = $1 order by created_at desc limit 31) t order by created_at", [item.id]),
    queryPg<{ text: string }>(`select text from relay_talk where owner_id = $1::uuid and role = 'alex' and item_id <> $2 and created_at > now() - interval '30 days'
      order by created_at desc limit 20`, [owner.id, item.id]),
  ]);
  const live = rows.filter((r) => r.mail_message_id);
  const before = await threadSides(item.id, owner.id, live.map((r) => guardOf(r)), stock);
  const mainOf = new Map(live.map((r) => [r.id, splitCopy(r.body_text, signatures.get(r.identity_key ?? "") ?? null).main]));
  const drafts: TalkDraftIn[] = live.map((r) => ({
    id: r.id, role: r.role, title: r.title, to: r.to_emails, toKind: before.kinds.get(r.id) ?? "other", body: mainOf.get(r.id) ?? "",
    sendMode: r.send_mode, sendAt: r.send_at, included: r.role === "primary" || r.included, sent: isSent(r),
  }));
  // The turn just added is the last one; the prompt gets it as "Alex says now".
  const prompt = talkPrompt({ context: ctx.prompt, rules: ctx.rules, guide: ctx.guide, drafts, turns: turns.slice(0, -1), target, stock, text, earlierAsks: asks.map((a) => a.text), now: new Date() });
  const { answer: said, notes } = parseTalk(await askAgent(prompt.system, prompt.user, 180_000), drafts, { known: `${ctx.known}\n${stockBlock(stock)}\n${text}` });

  const applied: TalkApplied = { edits: [], added: [], blocked: [], todo: null, ruleOffer: said.ruleOffer, research: null, prices: [], guard: null };
  // The emails as they will be after this turn, so the guard sees the buyer's new prices and the new recipients.
  const planned = [
    ...live.map((r) => guardOf(r, said.edits.find((e) => e.draftId === r.id)?.body)),
    ...said.add.map((a, i): GuardDraft => ({ id: `new:${i}`, role: "follow", to_kind: toKindOf(a.kind), to: [a.to], body: a.body })),
  ];
  const sides = await threadSides(item.id, owner.id, planned, stock);
  const checked = new Set<ToKind>();
  const touched: { id: string; kind: ToKind }[] = [];

  for (const edit of said.edits) {
    const row = live.find((r) => r.id === edit.draftId)!;
    const kind = sides.kinds.get(row.id) ?? "other";
    const problems = leaks({ toKind: kind, body: edit.body }, sides.facts);
    if (problems.length) { applied.blocked.push({ draftId: row.id, title: row.title, why: leakSentence(row.to_emails.join(", "), problems) }); continue; }
    if (row.scheduled) { applied.blocked.push({ draftId: row.id, title: row.title, why: "It's waiting to send. Cancel the send first, then ask again." }); continue; }
    const mail = await readMailDraft(row.mail_message_id!, owner.id);
    if (!mail || mail.state !== "draft") { applied.blocked.push({ draftId: row.id, title: row.title, why: "It has already gone." }); continue; }
    const old = mainOf.get(row.id) ?? "";
    if (!mail.attachments.length && claimsAttachment(edit.body) && !claimsAttachment(old)) {
      applied.blocked.push({ draftId: row.id, title: row.title, why: "I can't attach files from here. Use Attach stock list, or add the file in Gmail." });
      continue;
    }
    try {
      await saveDraftBody(row.id, mail, { body: edit.body }, { reason: text, by: "relay" });
    } catch (error) { applied.blocked.push({ draftId: row.id, title: row.title, why: blockedWhy(error) }); continue; }
    applied.edits.push({ draftId: row.id, title: row.title, reason: edit.reason || text, marks: marks(old, edit.body) });
    touched.push({ id: row.id, kind });
    checked.add(kind);
  }

  const counterpart = (item.counterpart_email ?? "").toLowerCase();
  const replySubject = (() => {
    const subject = (ctx.messages[0]?.subject ?? item.headline ?? "").trim();
    return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  })();
  for (const [index, add] of said.add.entries()) {
    const kind = sides.kinds.get(`new:${index}`) ?? toKindOf(add.kind);
    const problems = leaks({ toKind: kind, body: add.body }, sides.facts);
    if (problems.length) { applied.blocked.push({ draftId: null, title: add.title, why: leakSentence(add.toName || add.to, problems) }); continue; }
    // A chase to the person on this thread goes on the thread, as the reply does; anything else is a new email from Alex.
    const onThread = add.kind === "buyer" && !!item.mail_thread_id && add.to === counterpart;
    let mailId: string;
    try {
      mailId = await createMailDraft({ identity: onThread ? ctx.identity : "alex", to: [add.to], replyAll: false, thread: onThread ? item.mail_thread_id : null, subject: onThread ? replySubject : add.subject, body: add.body });
    } catch (error) { applied.blocked.push({ draftId: null, title: add.title, why: blockedWhy(error) }); continue; }
    const [made] = await queryPg<{ id: string }>(
      `insert into relay_draft (item_id, role, position, title, why, mail_message_id, source_note, original_body, origin, send_mode, send_at, included, to_kind)
       values ($1, 'follow', (select coalesce(max(position), 0) + 1 from relay_draft where item_id = $1), $2, $3, $4, $5, $6, 'note', $7, $8, $9, $10) returning id`,
      [item.id, add.title, add.why, mailId, text.slice(0, 2000), add.body, add.sendMode, add.sendAt, add.included, kind]);
    applied.added.push({ draftId: made.id, title: add.title, to: add.to, kind: add.kind, sendMode: add.sendMode, sendAt: add.sendAt, included: add.included });
    touched.push({ id: made.id, kind });
    checked.add(kind);
  }

  if (said.todo) {
    const [todo] = await queryPg<{ id: string }>(
      `insert into relay_todo (item_id, owner_id, title, detail, kind) select $1, $2::uuid, $3, $4, 'promise'
       where not exists (select 1 from relay_todo where item_id = $1 and lower(title) = lower($3) and state in ('suggested', 'accepted')) returning id`,
      [item.id, owner.id, said.todo.title, said.todo.detail]);
    if (todo) applied.todo = { id: todo.id, title: said.todo.title };
  }

  // A supplier email never gets the buyer's price, so only the others are priced.
  for (const t of touched.filter((x) => x.kind !== "supplier")) {
    const [now] = await queryPg<{ body_text: string | null }>("select m.body_text from relay_draft d join mail_message m on m.id = d.mail_message_id where d.id = $1", [t.id]);
    if (!hasPriceMarker(now?.body_text ?? "")) continue;
    try {
      applied.prices.push({ draftId: t.id, fills: await priceDraft(t.id, owner.id) });
    } catch (error) {
      console.error("relay talk pricing", error);
      notes.push("Couldn't work out the prices just now. The price gaps are still open.");
    }
  }

  if (said.research) {
    const primary = drafts.find((d) => d.role === "primary" && !d.sent);
    try {
      await startResearchJob(item, owner.id, said.research.ask, primary?.body ?? "");
      applied.research = { ask: said.research.ask, started: true };
    } catch (error) {
      applied.research = { ask: said.research.ask, started: false, why: blockedWhy(error) };
    }
  }

  if (checked.has("buyer") || checked.has("supplier")) {
    applied.guard = [checked.has("supplier") && "The supplier never sees the buyer's name or price", checked.has("buyer") && "the buyer never sees the supplier or their cost"]
      .filter(Boolean).join(", and ").replace(/^t/, "T") + ".";
  }
  const read = await readFor(item, owner.id, rows, stock, ctx.pack.sources);
  const did = [applied.edits.length && `changed ${applied.edits.length === 1 ? "1 email" : `${applied.edits.length} emails`}`, applied.added.length && `added ${applied.added.length === 1 ? "1 email" : `${applied.added.length} emails`}`].filter(Boolean).join(" and ");
  await addTurn(item.id, owner.id, "trace", did ? `${read.line}. Then ${did}.` : `${read.line}.`, target, { ms: Date.now() - started, read, notes });
  const blocked = applied.blocked.map((b) => `I didn't save "${b.title}": ${b.why}`).join("\n");
  await addTurn(item.id, owner.id, "relay", [said.say, blocked].filter(Boolean).join("\n\n"), target, applied);
}

/** Undo puts back the copy before the last change and keeps the undone one for Redo; Redo does the reverse. */
export async function undoDraft(draftId: string, ownerId: string, redo = false): Promise<TalkDraft[]> {
  const { item, row } = await ownDraft(draftId, ownerId);
  const mail = await readMailDraft(row.mail_message_id!, ownerId);
  if (!mail || mail.state !== "draft") throw new RelayError(409, "This email was already sent.");
  if (row.scheduled) throw new RelayError(409, "It's waiting to send. Cancel the send first.");
  const from = readHistory(redo ? row.redo : row.history);
  const entry = from.pop();
  if (!entry) throw new RelayError(409, redo ? "Nothing to redo." : "Nothing to undo.");
  const signatures = await identitySignatures();
  const current = splitCopy(row.body_text, signatures.get(row.identity_key ?? "") ?? null).main;
  await editDraft(mail, { body: entry.body });
  const back: HistoryEntry = { body: current, at: new Date().toISOString(), reason: entry.reason, by: "undo" };
  const [history, redoStack] = redo ? [pushHistory(row.history, back), from] : [from, pushHistory(row.redo, back)];
  await queryPg("update relay_draft set history = $2::jsonb, redo = $3::jsonb, updated_at = now() where id = $1", [draftId, JSON.stringify(history), JSON.stringify(redoStack)]);
  return refreshed(item, ownerId);
}

async function ownDraft(draftId: string, ownerId: string): Promise<{ item: RelayItem; row: Row; rows: Row[] }> {
  const [found] = await queryPg<{ item_id: string }>("select d.item_id from relay_draft d join relay_item i on i.id = d.item_id where d.id = $1 and i.owner_id = $2::uuid", [draftId, ownerId]);
  if (!found) throw new RelayError(404, "Not found");
  const item = await ownItem(found.item_id, ownerId);
  const rows = await draftRows(item.id);
  const row = rows.find((r) => r.id === draftId);
  if (!row?.mail_message_id) throw new RelayError(404, "Not found");
  return { item, row, rows };
}

async function refreshed(item: RelayItem, ownerId: string): Promise<TalkDraft[]> {
  const [rows, stock] = await Promise.all([draftRows(item.id), stockFits(item.id, ownerId)]);
  return draftViews(item, ownerId, rows, stock);
}

export type LinkedPatch = { included?: boolean; sendMode?: SendMode; sendAt?: string | null };

/** Ticks a linked email to go or not, and sets when it goes. The reply always goes; a waiting send has to be cancelled first. */
export async function setLinked(draftId: string, ownerId: string, patch: LinkedPatch): Promise<TalkDraft[]> {
  const { item, row } = await ownDraft(draftId, ownerId);
  if (row.role === "primary") throw new RelayError(400, "The reply always goes. Change the linked emails instead.");
  if (isSent(row)) throw new RelayError(409, "This email was already sent.");
  if (row.scheduled) throw new RelayError(409, "It's waiting to send. Cancel the send first.");
  const mode = patch.sendMode ?? row.send_mode;
  if (!SEND_MODES.includes(mode)) throw new RelayError(400, "That isn't a way to send.");
  let at = patch.sendAt === undefined ? row.send_at : patch.sendAt;
  if (mode === "at" || mode === "unless_reply") {
    if (!at) throw new RelayError(400, "Pick when it goes.");
    const when = new Date(at);
    const problem = sendAtProblem(when);
    if (problem) throw new RelayError(400, problem);
    at = when.toISOString();
  } else at = null;
  await queryPg("update relay_draft set included = $2, send_mode = $3, send_at = $4, updated_at = now() where id = $1",
    [draftId, patch.included ?? row.included, mode, at]);
  return refreshed(item, ownerId);
}

export type SendOutcome = { draftId: string; title: string; outcome: "queued" | "scheduled" | "todo" | "cancelled" | "failed"; at?: string; why?: string };

/**
 * "Send the reply and N more", on Alex's confirm: the reply and every ticked with_reply email go through queueSend (the
 * 30 second hold), the at and unless_reply ones through scheduleSend, and the after_order ones become a to-do. Everything
 * is checked first (the version Alex saw, a recipient, no gap, no leak, a usable time) and nothing goes if any fails.
 * Each send then goes through the normal path, which checks the gap and the leak again.
 */
export async function sendWithLinked(itemId: string, owner: { id: string; email: string }, updatedAtByDraft: Record<string, string>): Promise<{ results: SendOutcome[]; drafts: TalkDraft[] }> {
  const item = await ownItem(itemId, owner.id);
  const [rows, stock] = await Promise.all([draftRows(itemId), stockFits(itemId, owner.id)]);
  const signatures = await identitySignatures();
  const open = rows.filter((r) => r.mail_message_id && !isSent(r));
  const primary = open.find((r) => r.role === "primary");
  const linked = open.filter((r) => r.role === "follow" && r.included);
  const going = [...(primary ? [primary] : []), ...linked.filter((r) => r.send_mode !== "after_order")];
  if (!going.length && !linked.length) throw new RelayError(409, "There's nothing here to send.");

  const sides = await threadSides(itemId, owner.id, rows.filter((r) => r.mail_message_id).map((r) => guardOf(r)), stock);
  const problems: string[] = [];
  for (const r of going) {
    const name = r.role === "primary" ? "The reply" : `"${r.title}"`;
    const seen = updatedAtByDraft[r.id];
    if (!seen || !r.updated_at || !sameVersion(r.updated_at, seen)) { problems.push(`${name} changed since you opened it. Reload to see the latest.`); continue; }
    if (r.scheduled) { problems.push(`${name} is already waiting to send.`); continue; }
    if (!r.to_emails.length) problems.push(`${name} has no recipient.`);
    if (unfilledGaps(splitCopy(r.body_text, signatures.get(r.identity_key ?? "") ?? null).main, parseFills(r.fills)).length) problems.push(`${name} has a gap to fill in.`);
    const found = leaks({ toKind: sides.kinds.get(r.id) ?? "other", body: r.body_text ?? "" }, sides.facts);
    if (found.length) problems.push(leakSentence(r.to_emails.join(", "), found));
    if (r.send_mode === "at" || r.send_mode === "unless_reply") {
      const problem = r.send_at ? sendAtProblem(new Date(r.send_at)) : "Pick when it goes.";
      if (problem && r.role === "follow") problems.push(`${name}: ${problem}`);
    }
  }
  if (problems.length) throw new RelayError(409, `Nothing was sent. ${problems.join(" ")}`);

  const results: SendOutcome[] = [];
  // The reply first: if it can't go, none of the linked emails do.
  if (primary) {
    const held = await queueSend(primary.id, owner, updatedAtByDraft[primary.id]);
    results.push({ draftId: primary.id, title: primary.title, outcome: "queued", at: held.at });
  }
  for (const r of linked) {
    try {
      if (r.send_mode === "after_order") {
        const title = `Send "${r.title}" once ${item.counterpart_name ?? item.counterpart_email ?? "they"} orders`.slice(0, 160);
        const [todo] = await queryPg<{ id: string }>(
          `insert into relay_todo (item_id, owner_id, title, detail, kind) select $1, $2::uuid, $3, 'The linked email is ready in Relay', 'suggested'
           where not exists (select 1 from relay_todo where item_id = $1 and title = $3 and state in ('suggested', 'accepted')) returning id`, [itemId, owner.id, title]);
        if (todo) await acceptTodo(todo.id, owner);
        results.push({ draftId: r.id, title: r.title, outcome: "todo" });
      } else if (r.send_mode === "with_reply") {
        const held = await queueSend(r.id, owner, updatedAtByDraft[r.id]);
        results.push({ draftId: r.id, title: r.title, outcome: "queued", at: held.at });
      } else {
        const unless: UnlessReply | null = r.send_mode === "unless_reply" ? {
          threads: [...new Set([r.thread_id, item.mail_thread_id].filter((t): t is string => !!t))],
          from: [...new Set([...r.to_emails, ...(r.thread_id && r.thread_id === item.mail_thread_id && item.counterpart_email ? [item.counterpart_email] : [])].map((a) => a.toLowerCase()))],
        } : null;
        const scheduled = await scheduleSend(r.id, owner, updatedAtByDraft[r.id], new Date(r.send_at!), { unlessReply: unless });
        results.push({ draftId: r.id, title: r.title, outcome: "scheduled", at: scheduled.at });
      }
    } catch (error) {
      // The reply is already held, so one linked email failing must not hide what happened to the rest.
      if (!(error instanceof RelayError || error instanceof DraftActionError)) console.error("relay send with linked", error);
      const why = error instanceof RelayError || error instanceof DraftActionError ? error.message : "Couldn't queue it. Try it on its own.";
      results.push({ draftId: r.id, title: r.title, outcome: "failed", why });
    }
  }
  return { results, drafts: await refreshed(item, owner.id) };
}

/** Undo for "Send the reply and N more": stops every send still held or scheduled on this email. One that has already
 * started going is reported, not hidden. */
export async function cancelAll(itemId: string, ownerId: string): Promise<{ results: SendOutcome[]; drafts: TalkDraft[] }> {
  const item = await ownItem(itemId, ownerId);
  const waiting = (await draftRows(itemId)).filter((r) => r.scheduled && r.mail_state === "draft");
  const results: SendOutcome[] = [];
  for (const r of waiting) {
    try {
      await cancelScheduledSend(r.id, ownerId);
      results.push({ draftId: r.id, title: r.title, outcome: "cancelled" });
    } catch (error) {
      results.push({ draftId: r.id, title: r.title, outcome: "failed", why: blockedWhy(error) });
    }
  }
  return { results, drafts: await refreshed(item, ownerId) };
}
