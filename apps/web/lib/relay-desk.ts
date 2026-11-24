import "server-only";
import { addLesson, readLessons } from "./relay-lessons";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { queryPg, withPgTransaction } from "./postgres";
import { readMailDraft } from "./crm-postgres/mail";
import { identitySignatures, splitCopy } from "./mail-draft-actions";
import { isTeamSender } from "./relay-senders";
import { listingProposal, proposeListings, settleStaleListings } from "./relay-listings";
import { mailboxScopeSql } from "./mail-scope";
import { getSupabaseAdminClient } from "./platform-admin/supabase";
import {
  checkRelayEdit, claimsAttachment, createMailDraft, draftContext, editRelayDraft, readRelayItem, RELAY_OWNER_EMAIL, RelayError, replyAllPeople,
  saveDraftBody, saveDraftOutputs, voiceFor, type RelayItem,
} from "./relay";
import { listingActivity, marketplace as marketplaceAccount, sellerSetup, threadFiles, type ListingRow } from "./relay-context";
import { activityText, stripQuoted } from "./relay-context-core";
import { draftPriceGaps, marketplaceListings, pennyCards, priceDraft, priceStock, setFill, stockFits } from "./relay-price";
import { parseFills } from "./relay-price-core";
import type { StockFit } from "./relay-price-types";
import { threadSides, type GuardDraft } from "./relay-leak";
import { leaks, leakSentence } from "./relay-leak-core";
import { sendAtProblem } from "./relay-send-time";
import { hasPriceMarker, type ToKind } from "./relay-talk-core";
import { addTurn, draftRows, guardOf, isSent, type TalkRow } from "./relay-talk";
import {
  ACTIVE_STATUSES, buildBrief, cappedSql, checkReadOnlySql, claudeSessionCommand, deskPrompt, matchesQuery, MODE_TIMEOUT, readDeskArgs, rowsAnswer,
  SQL_TIMEOUT_MS, staleAfterSeconds, WRITE_TOOLS, type DeskArgs, type DeskDraft, type DeskMode, type DeskState, type DeskStatus, type DeskTool,
} from "./relay-desk-core";

/**
 * Relay's desk, the CRM part. Every Relay email can have its own resumable Claude Code session (relay_item.desk_session_id);
 * each first draft and each chat message is one run of it (relay_desk_run), carried out by scripts/rebattery/relay_desk.py.
 * The session reads with its own read-only tools and changes Relay's drafts only through the relay_* MCP tools, which land
 * here (deskTool) and go through the same guarded code as the rest of Relay: the leak guard, history and Undo, version
 * checks, the gap fields and the mail CLI's content policy. Nothing here sends, and nothing creates a Gmail draft.
 */

const RUNNER = process.env.RELAY_DESK_RUNNER || "/root/denchclaw/scripts-live/scripts/rebattery/relay_desk.py";

export type DeskRun = { id: string; item_id: string; mode: DeskMode; status: DeskStatus; started_at: string | null; created_at: string; error: string | null };
/** What the chat page shows about the desk: the turn in progress, if any, and the command for "Continue in Claude". */
export type DeskView = { run: Pick<DeskRun, "id" | "status" | "mode" | "started_at"> | null; claudeSession: string | null };

const RUN_COLUMNS = "id, item_id, mode, status, started_at::text as started_at, created_at::text as created_at, error";

/** A run whose runner died (a restart, a crash) would hold the email forever: past its mode's limit it is marked failed. */
async function settleStale(itemId: string): Promise<void> {
  await queryPg(
    `update relay_desk_run set status = 'failed', error = coalesce(error, 'The desk stopped answering.'), finished_at = now()
     where item_id = $1 and status = any($2) and created_at < now() - make_interval(secs => case mode when 'quick' then $3::int when 'ahead' then $4::int else $5::int end)`,
    [itemId, ACTIVE_STATUSES, staleAfterSeconds("quick"), staleAfterSeconds("ahead"), staleAfterSeconds("chat")]);
}

async function ownItem(itemId: string, ownerId: string): Promise<RelayItem> {
  const item = await readRelayItem(itemId, ownerId);
  if (!item) throw new RelayError(404, "Not found");
  return item;
}

/**
 * Starts one desk turn on an email and its runner, detached. chat needs Alex's text, which is added to the chat at once.
 * One turn per email at a time: the database's unique index refuses a second (409). Throws 503 when the runner can't be
 * started, so the caller can fall back to the one-shot paths (talk, draftFromNote).
 */
/** The desk runs only while this file exists. The one-shot drafting answers instead when it doesn't (every caller falls back on a 503). */
const DESK_ON_FLAG = process.env.RELAY_DESK_FLAG || "/root/.hermes/workspace/relay/desk-on";

export async function startDesk(itemId: string, ownerId: string, mode: DeskMode, text: string): Promise<DeskRun> {
  await ownItem(itemId, ownerId);
  const said = text.trim();
  if (mode === "chat" && !said) throw new RelayError(400, "Say what you want Relay to do.");
  try { accessSync(RUNNER, constants.R_OK); } catch { throw new RelayError(503, "Relay's desk isn't installed here."); }
  // Switched on by a flag file, so the desk can go live dark and be turned on (or off) without a deploy.
  try { accessSync(DESK_ON_FLAG, constants.R_OK); } catch { throw new RelayError(503, "Relay's desk is switched off."); }
  await settleStale(itemId);
  let run: DeskRun;
  try {
    [run] = await queryPg<DeskRun>(`insert into relay_desk_run (item_id, owner_id, mode, text) values ($1, $2::uuid, $3, $4) returning ${RUN_COLUMNS}`,
      [itemId, ownerId, mode, said.slice(0, 4000)]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new RelayError(409, "Relay is already working on this email.");
    throw error;
  }
  if (mode === "chat") await addTurn(itemId, ownerId, "alex", said, "all", null);
  try {
    const child = spawn("/usr/bin/python3", [RUNNER, run.id], { detached: true, stdio: "ignore" });
    child.on("error", (error) => {
      console.error("relay desk runner", run.id, error);
      void queryPg("update relay_desk_run set status = 'failed', error = 'The desk could not start.', finished_at = now() where id = $1 and status = 'queued'", [run.id]);
    });
    child.unref();
  } catch (error) {
    await queryPg("update relay_desk_run set status = 'failed', error = 'The desk could not start.', finished_at = now() where id = $1", [run.id]);
    console.error("relay desk spawn", error);
    throw new RelayError(503, "Relay's desk could not start.");
  }
  return run;
}

/** Stop: a queued turn is dropped; a running one is marked stopping and the runner kills its process group within seconds. */
export async function stopDesk(itemId: string, ownerId: string): Promise<DeskRun> {
  await ownItem(itemId, ownerId);
  const [run] = await queryPg<DeskRun>(
    `update relay_desk_run set status = case status when 'queued' then 'stopped' else 'stopping' end,
       finished_at = case status when 'queued' then now() else finished_at end
     where item_id = $1 and status in ('queued', 'running') returning ${RUN_COLUMNS}`, [itemId]);
  if (!run) throw new RelayError(409, "Relay isn't working on this email.");
  return run;
}

/** The turn in progress on an email, if any, and its Claude Code session for "Continue in Claude". */
export async function deskView(itemId: string): Promise<DeskView> {
  await settleStale(itemId);
  const [[run], [item]] = await Promise.all([
    queryPg<DeskRun>(`select ${RUN_COLUMNS} from relay_desk_run where item_id = $1 and status = any($2) order by created_at desc limit 1`, [itemId, ACTIVE_STATUSES]),
    queryPg<{ desk_session_id: string | null }>("select desk_session_id from relay_item where id = $1", [itemId]),
  ]);
  return {
    run: run ? { id: run.id, status: run.status, mode: run.mode, started_at: run.started_at } : null,
    claudeSession: item?.desk_session_id ? claudeSessionCommand(item.desk_session_id) : null,
  };
}

/** Waits for a run to end (done, failed or stopped), checking every few seconds, up to its mode's limit and a margin. */
export async function waitForDesk(runId: string, mode: DeskMode): Promise<DeskStatus> {
  const until = Date.now() + (staleAfterSeconds(mode) + 30) * 1000;
  while (Date.now() < until) {
    const [row] = await queryPg<{ status: DeskStatus }>("select status from relay_desk_run where id = $1", [runId]);
    if (!row) return "failed";
    if (!ACTIVE_STATUSES.includes(row.status)) return row.status;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return "failed";
}

// ---------- for the runner and the MCP tools (internal secret) ----------

/** The owner the internal calls act for: Relay is Alex's alone. */
export async function deskOwner(): Promise<string> {
  const [owner] = await queryPg<{ id: string }>("select id from crm_users where lower(email) = lower($1)", [RELAY_OWNER_EMAIL]);
  if (!owner) throw new RelayError(404, "No Relay owner");
  return owner.id;
}

type Ctx = { item: RelayItem; ownerId: string; runId: string | null; dryRun: boolean };

/** The email's facts, thread, drafts (with versions and prices), the stock that fits with Relay's prices, and the rules. */
export async function deskState(item: RelayItem, ownerId: string): Promise<DeskState> {
  await settleStaleListings(item.id).catch(() => undefined);
  const [ctx, rows, stock, signatures, listings] = await Promise.all([
    draftContext(item, ownerId, "(desk)", { background: false, offers: false }),
    draftRows(item.id),
    stockFits(item.id, ownerId).catch((error) => { console.error("relay desk stock", error); return [] as StockFit[]; }),
    identitySignatures(),
    listingProposal(item.id).catch(() => null),
  ]);
  const priced = await priceStock(stock, { askedDelivered: false }).catch(() => []);
  const sides = await threadSides(item.id, ownerId, rows.filter((r) => r.mail_message_id).map((r) => guardOf(r)), stock);
  const drafts: DeskDraft[] = rows.filter((r) => r.mail_message_id).map((r) => ({
    id: r.id, role: r.role, title: r.title, to: r.to_emails, cc: r.cc_emails, bcc: r.bcc_emails, subject: r.subject,
    body: splitCopy(r.body_text, signatures.get(r.identity_key ?? "") ?? null).main,
    version: r.updated_at ? new Date(r.updated_at).toISOString() : null, to_kind: sides.kinds.get(r.id) ?? r.to_kind ?? "other",
    send_mode: r.send_mode, send_at: r.send_at, included: r.role === "primary" || r.included,
    waiting_to_send: !!(r.mail_state === "draft" && r.scheduled?.at), sent: isSent(r),
    fills: parseFills(r.fills).map(({ key, label, value, by, basis, working, warnings }) => ({ key, label, value, by, basis, working, warnings })),
  }));
  const deal = item.deal ?? null;
  // Who the reply goes from: the draft's sender once there is one (Alex may have switched it), else Relay's pick.
  const from = rows.find((r) => r.role === "primary" && r.mail_message_id)?.identity_key ?? ctx.identity;
  return {
    item: {
      id: item.id, who: { name: item.counterpart_name, email: item.counterpart_email, company: item.company }, contact_type: item.contact_type,
      situation: item.situation, headline: item.headline, tab: item.tab, waiting_since: item.waiting_since,
      sending_as: from === "supply" ? "supply@rebattery.io (ReBattery's seller inbox)" : from === "buy" ? "buy@rebattery.io (ReBattery's buyer inbox)" : "Alex's own address",
      reply_to: ctx.to || null,
      team_inbox: isTeamSender(from) ? `${from}@rebattery.io` : null,
      deal: item.bulk_listing_id ? { label: item.deal_label, summary: deal?.summary ?? null, quantity: deal?.quantity ?? null, status: deal?.status ?? null, price: deal?.price ?? null, stage: deal?.stage ?? null } : null,
    },
    thread: ctx.messages.map((m) => ({
      message_id: m.id, direction: m.direction ?? "", from: m.from_email, to: m.to_emails, cc: m.cc_emails, at: m.at, subject: m.subject,
      text: stripQuoted(m.body_text ?? "").slice(0, 4000), has_files: !!m.has_files,
    })),
    others: await otherEmails(item, ownerId),
    drafts,
    listings,
    stock: stock.map((s, i) => ({
      key: s.key, label: s.label, kind: s.kind, kwh: s.kwh, year: s.year, soh: s.soh, cost: s.cost, listed: s.listed,
      supplier: { name: s.supplier.name, country: s.supplier.country },
      relay_price: priced[i] ? { value: priced[i].value, basis: priced[i].basis, working: priced[i].working, warnings: priced[i].warnings } : null,
    })),
    rules: ctx.rules,
  };
}

/** The same person's other emails still waiting on Alex (open, or drafted and unsent), on other threads, newest first. */
async function otherEmails(item: RelayItem, ownerId: string): Promise<NonNullable<DeskState["others"]>> {
  if (!item.counterpart_email) return [];
  const rows = await queryPg<{ id: string; last_message: RelayItem["last_message"]; headline: string }>(
    `select id, last_message, headline from relay_item where owner_id = $1::uuid and id <> $2 and status in ('open', 'review')
       and lower(counterpart_email) = lower($3) order by updated_at desc limit 5`, [ownerId, item.id, item.counterpart_email]);
  return rows.filter((r) => r.last_message?.direction === "inbound").map((r) => ({
    item_id: r.id, subject: r.headline, at: r.last_message?.at ?? null, text: stripQuoted(r.last_message?.text ?? "").slice(0, 3000),
  }));
}

/** The brief (appended to the session's system prompt) and the prompt for one turn, both built fresh from the email now. */
export async function deskBrief(itemId: string, mode: DeskMode, text: string): Promise<{ brief: string; prompt: string; timeoutSeconds: number }> {
  const ownerId = await deskOwner();
  const item = await ownItem(itemId, ownerId);
  const state = await deskState(item, ownerId);
  const theirs = state.thread.find((m) => m.direction === "inbound")?.text ?? item.last_message?.text ?? "";
  const voice = await voiceFor(ownerId, item, theirs);
  return { brief: buildBrief({ mode, state, rules: state.rules, voice, lessons: await readLessons(), now: new Date() }), prompt: deskPrompt(mode, text), timeoutSeconds: MODE_TIMEOUT[mode] };
}

/** A write is only taken from the run that is working on this email right now, so a stray or stopped process can't change anything. */
async function liveRun(ctx: Ctx): Promise<void> {
  if (ctx.dryRun) return;
  if (!ctx.runId) throw new RelayError(403, "No desk run.");
  const [run] = await queryPg<{ status: DeskStatus }>("select status from relay_desk_run where id = $1 and item_id = $2", [ctx.runId, ctx.item.id]);
  if (!run) throw new RelayError(403, "That desk run isn't on this email.");
  if (run.status !== "running") throw new RelayError(409, run.status === "stopping" ? "Alex stopped this turn. Don't change anything else." : "This desk turn has ended.");
}

/**
 * One MCP tool call from the desk. Arguments are read strictly; writes need the live run. In a dry run every write tool
 * runs its checks (ownership, version, the leak guard, send times) and says what it would do, without writing.
 */
export async function deskTool(input: { itemId: string; runId: string | null; dryRun: boolean }, tool: DeskTool, raw: unknown): Promise<string> {
  const checked = readDeskArgs(tool, raw);
  if (!checked.ok) throw new RelayError(400, checked.why);
  const ownerId = await deskOwner();
  const ctx: Ctx = { item: await ownItem(input.itemId, ownerId), ownerId, runId: input.runId, dryRun: input.dryRun };
  if (WRITE_TOOLS.includes(tool)) await liveRun(ctx);
  const args = checked.args as DeskArgs[DeskTool];
  switch (tool) {
    case "relay_state": return JSON.stringify(await deskState(ctx.item, ownerId));
    case "relay_write_reply": return writeReply(ctx, args as DeskArgs["relay_write_reply"]);
    case "relay_update_draft": return updateDraft(ctx, args as DeskArgs["relay_update_draft"]);
    case "relay_add_email": return addEmail(ctx, args as DeskArgs["relay_add_email"]);
    case "relay_set_price": return setPrice(ctx, args as DeskArgs["relay_set_price"]);
    case "relay_reprice": return reprice(ctx, args as DeskArgs["relay_reprice"]);
    case "relay_add_todo": return addTodo(ctx, args as DeskArgs["relay_add_todo"]);
    case "relay_remember_lesson": return rememberLesson(ctx, args as DeskArgs["relay_remember_lesson"]);
    case "relay_ask": return ask(ctx, args as DeskArgs["relay_ask"]);
    case "relay_propose_listings": {
      const a = args as DeskArgs["relay_propose_listings"];
      return proposeListings(ctx.item, ctx.ownerId, a.groups, a.why, ctx.dryRun);
    }
    case "crm_query": return crmQuery((args as DeskArgs["crm_query"]).sql);
    case "marketplace_account": {
      const found = await marketplaceAccount((args as DeskArgs["marketplace_account"]).email);
      return found ? JSON.stringify(found) : "Couldn't read the marketplace just now. Say nothing about their account.";
    }
    case "marketplace_listings": {
      const a = args as DeskArgs["marketplace_listings"];
      const { listings, errors } = await marketplaceListings(a.query, a.limit);
      return JSON.stringify({
        listings: listings.map((c) => ({ id: c.key.replace(/^listing:/, ""), title: c.title, seller: c.seller, make: c.make, model: c.model, kwh: c.kwh, price: c.price, currency: c.currency, country: c.country, year: c.year, soh: c.soh, link: c.href })),
        note: errors.length ? errors.join(" ") : undefined,
      });
    }
    case "marketplace_deal": return marketplaceRecord((args as DeskArgs["marketplace_deal"]).id);
    case "attachment_text": return attachmentText(ctx, (args as DeskArgs["attachment_text"]).message_id);
    case "penny_price": {
      const battery = (args as DeskArgs["penny_price"]).battery;
      const cards = (await pennyCards()).filter((c) => matchesQuery(`${c.battery_key} ${c.battery} ${c.segment}`, battery)).slice(0, 5);
      return cards.length ? JSON.stringify(cards) : `Penny has no price card matching "${battery}".`;
    }
  }
  throw new RelayError(400, "Unknown tool.");
}

// ---------- the write tools ----------

const dry = (would: string) => `DRY RUN, nothing was changed. Would: ${would}`;
const mainOf = async (r: TalkRow) => splitCopy(r.body_text, (await identitySignatures()).get(r.identity_key ?? "") ?? null).main;

/** What the leak guard says about one Relay email as it would be after this change, checked against everything on the thread. */
async function guard(ctx: Ctx, rows: TalkRow[], target: GuardDraft): Promise<{ kind: ToKind; refusal: string | null }> {
  const planned = [...rows.filter((r) => r.mail_message_id && r.id !== target.id).map((r) => guardOf(r)), target];
  const sides = await threadSides(ctx.item.id, ctx.ownerId, planned);
  const kind = sides.kinds.get(target.id) ?? "other";
  const problems = leaks({ toKind: kind, body: target.body }, sides.facts);
  return { kind, refusal: problems.length ? `${leakSentence(target.to.join(", ") || "them", problems)} Rewrite it without that.` : null };
}

/** The draft as it is after a change, for the tool's answer: its id, version and Relay's prices. */
async function after(draftId: string, note: string): Promise<string> {
  const row = (await draftRows((await queryPg<{ item_id: string }>("select item_id from relay_draft where id = $1", [draftId]))[0]?.item_id ?? "")).find((r) => r.id === draftId);
  if (!row) return note;
  const fills = parseFills(row.fills).map((f) => ({ key: f.key, label: f.label, value: f.value, by: f.by, working: f.working }));
  return JSON.stringify({ done: note, draft_id: row.id, version: row.updated_at ? new Date(row.updated_at).toISOString() : null, prices: fills });
}

/** Prices a buyer-side draft that carries price markers. A supplier email never gets the buyer's price. */
async function priceIfMarked(ctx: Ctx, draftId: string, kind: ToKind, body: string): Promise<string> {
  if (kind === "supplier" || !hasPriceMarker(body)) return "";
  try {
    await priceDraft(draftId, ctx.ownerId);
    return " Priced it.";
  } catch (error) {
    if (!(error instanceof RelayError)) console.error("relay desk pricing", error);
    return " Couldn't work out the prices just now; the price gaps are still open.";
  }
}

async function writeReply(ctx: Ctx, a: DeskArgs["relay_write_reply"]): Promise<string> {
  const rows = await draftRows(ctx.item.id);
  const primary = rows.find((r) => r.role === "primary" && r.mail_message_id && !isSent(r));
  if (claimsAttachment(a.body) && !(primary && claimsAttachment(await mainOf(primary)))) {
    throw new RelayError(422, "Nothing can be attached from here. Don't say a file is attached; say Alex will send it, and suggest a to-do.");
  }
  if (primary) {
    if (primary.scheduled) throw new RelayError(409, "The reply is waiting to send. Alex has to cancel the send before it can change.");
    const { kind, refusal } = await guard(ctx, rows, guardOf(primary, a.body));
    if (refusal) throw new RelayError(422, refusal);
    const mail = await readMailDraft(primary.mail_message_id!, ctx.ownerId);
    if (!mail || mail.state !== "draft") throw new RelayError(409, "The reply has already gone.");
    if (ctx.dryRun) return dry(`replace the reply ${primary.id} to ${primary.to_emails.join(", ")} (Undo keeps the old copy)${a.subject ? `, subject "${a.subject}"` : ""}${hasPriceMarker(a.body) && kind !== "supplier" ? ", then price it" : ""}.\n--- new body ---\n${a.body}`);
    await saveDraftBody(primary.id, mail, { body: a.body, subject: a.subject }, { reason: a.reason, by: "relay" });
    return after(primary.id, `Replaced the reply.${await priceIfMarked(ctx, primary.id, kind, a.body)}`);
  }
  const draftCtx = await draftContext(ctx.item, ctx.ownerId, a.reason, { background: false, offers: false });
  const { refusal } = await guard(ctx, rows, { id: "new:reply", role: "primary", to_kind: null, to: [draftCtx.to], body: a.body });
  if (refusal) throw new RelayError(422, refusal);
  if (ctx.dryRun) {
    const [cc] = ctx.item.mail_thread_id ? await queryPg<{ people: string[] }>(`select ${replyAllPeople("$1")} as people`, [ctx.item.mail_thread_id]) : [];
    const copied = (cc?.people ?? []).filter((p) => p !== draftCtx.to.toLowerCase());
    return dry(`create the reply as ${draftCtx.identity} to ${draftCtx.to}${copied.length ? `, cc ${copied.join(", ")}` : ""} on the thread${a.subject ? `, subject "${a.subject}"` : ""}${hasPriceMarker(a.body) ? ", then price it" : ""}.\n--- body ---\n${a.body}`);
  }
  await saveDraftOutputs(ctx.item, ctx.ownerId, a.reason, draftCtx, { subject: a.subject ?? "", body: a.body, log: ["Written by Relay's desk"] }, [], "desk", true, { keepTodos: true });
  const [made] = await queryPg<{ id: string }>("select id from relay_draft where item_id = $1 and role = 'primary' and state = 'draft' order by created_at desc limit 1", [ctx.item.id]);
  return made ? after(made.id, "Wrote the reply.") : "Wrote the reply.";
}

async function updateDraft(ctx: Ctx, a: DeskArgs["relay_update_draft"]): Promise<string> {
  await knownAddresses(ctx, [...(a.to ?? []), ...(a.cc ?? []), ...(a.bcc ?? [])]);
  const rows = await draftRows(ctx.item.id);
  const row = rows.find((r) => r.id === a.draft_id && r.mail_message_id);
  if (!row) throw new RelayError(404, "That draft isn't on this email. Call relay_state for the ids.");
  if (isSent(row)) throw new RelayError(409, "That email has already gone.");
  const current = await mainOf(row);
  const body = a.body ?? current;
  if (a.body !== undefined && claimsAttachment(a.body) && !claimsAttachment(current)) {
    throw new RelayError(422, "Nothing can be attached from here. Don't say a file is attached; say Alex will send it.");
  }
  const { kind, refusal } = await guard(ctx, rows, { ...guardOf(row, body), to: a.to ?? row.to_emails });
  if (refusal) throw new RelayError(422, refusal);
  const edit = { body: a.body, subject: a.subject, to: a.to, cc: a.cc, bcc: a.bcc };
  if (ctx.dryRun) {
    await checkRelayEdit(row.id, ctx.ownerId, a.version, edit);
    const what = [a.body !== undefined && "the text", a.subject !== undefined && `the subject to "${a.subject}"`, a.to && `To to ${a.to.join(", ")}`, a.cc && `Cc to ${a.cc.join(", ") || "nobody"}`, a.bcc && `Bcc to ${a.bcc.join(", ") || "nobody"}`].filter(Boolean).join(", ");
    return dry(`change ${what} of "${row.title}" (${row.id}), recorded as Relay's change so Undo works.${a.body !== undefined ? `\n--- new body ---\n${a.body}` : ""}`);
  }
  await editRelayDraft(row.id, ctx.ownerId, a.version, edit, { reason: a.reason, by: "relay" });
  return after(row.id, `Updated "${row.title}".${await priceIfMarked(ctx, row.id, kind, body)}`);
}

/**
 * Refuses an address Relay has never seen: not a CRM contact, never a sender, not copied on an email they sent on this
 * thread (our own sends don't count: a wrong address would vouch for itself). Gmail search results drop the dots in
 * addresses (rickimayhew@ for ricki.mayhew@), and a made-up address bounces.
 */
async function knownAddresses(ctx: Ctx, addresses: string[]): Promise<void> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return;
  const known = new Set((await queryPg<{ a: string }>(
    `select a from unnest($1::text[]) a where exists (select 1 from crm_people p where lower(p.email) = a)
       or exists (select 1 from mail_message m where m.direction = 'inbound' and lower(m.from_email) = a)
       or exists (select 1 from mail_message m where m.thread_id = $2 and m.direction = 'inbound' and (lower(m.from_email) = a or a = any(select lower(x) from unnest(m.to_emails || m.cc_emails) x)))`,
    [wanted, ctx.item.mail_thread_id ?? ""])).map((r) => r.a));
  const unknown = wanted.filter((a) => !known.has(a));
  if (!unknown.length) return;
  const domains = [...new Set(unknown.map((a) => a.split("@")[1]).filter(Boolean))];
  const near = (await queryPg<{ a: string }>(
    `select distinct lower(email) as a from crm_people where split_part(lower(email), '@', 2) = any($1) limit 6`, [domains])).map((r) => r.a);
  throw new RelayError(422, `Relay has never had an email from ${unknown.join(", ")}, and it isn't a CRM contact, so it may bounce. Gmail search drops the dots in addresses: take the address from the CRM (crm_people) or from the From line of an email they sent.${near.length ? ` Known addresses there: ${near.join(", ")}.` : ""} If none fits, ask Alex.`);
}

async function addEmail(ctx: Ctx, a: DeskArgs["relay_add_email"]): Promise<string> {
  if (claimsAttachment(a.body)) throw new RelayError(422, "Nothing can be attached from here. Don't say a file is attached.");
  await knownAddresses(ctx, [a.to]);
  if (a.send_at) {
    const problem = sendAtProblem(new Date(a.send_at));
    if (problem) throw new RelayError(400, problem);
  }
  const rows = await draftRows(ctx.item.id);
  const { kind, refusal } = await guard(ctx, rows, { id: "new:email", role: "follow", to_kind: a.to_kind, to: [a.to], body: a.body });
  if (refusal) throw new RelayError(422, refusal);
  const counterpart = (ctx.item.counterpart_email ?? "").toLowerCase();
  // A chase to the person on this thread goes on the thread, as the reply does; anything else is a new email from Alex.
  const onThread = a.on_thread && !!ctx.item.mail_thread_id && a.to.toLowerCase() === counterpart;
  const title = (a.why || a.subject).slice(0, 120);
  if (ctx.dryRun) return dry(`add a linked email "${title}" to ${a.to} (${kind}), ${a.send_mode}${a.send_at ? ` at ${a.send_at}` : ""}${onThread ? ", on this thread" : ", as a new email from Alex"}.\nSubject: ${a.subject}\n--- body ---\n${a.body}`);
  const draftCtx = onThread ? await draftContext(ctx.item, ctx.ownerId, "(desk)", { background: false, offers: false }) : null;
  const subject = onThread ? (() => {
    const s = (draftCtx!.messages[0]?.subject ?? ctx.item.headline ?? "").trim();
    return /^re:/i.test(s) ? s : `Re: ${s}`;
  })() : a.subject;
  const mailId = await createMailDraft({ identity: onThread ? draftCtx!.identity : "alex", to: [a.to], replyAll: false, thread: onThread ? ctx.item.mail_thread_id : null, subject, body: a.body });
  const [made] = await queryPg<{ id: string }>(
    `insert into relay_draft (item_id, role, position, title, why, mail_message_id, source_note, original_body, origin, send_mode, send_at, included, to_kind)
     values ($1, 'follow', (select coalesce(max(position), 0) + 1 from relay_draft where item_id = $1), $2, $3, $4, $5, $6, 'desk', $7, $8, true, $9) returning id`,
    [ctx.item.id, title, a.why, mailId, "Relay's desk", a.body, a.send_mode, a.send_at, kind]);
  return after(made.id, `Added "${title}" to ${a.to}.${await priceIfMarked(ctx, made.id, kind, a.body)}`);
}

async function setPrice(ctx: Ctx, a: DeskArgs["relay_set_price"]): Promise<string> {
  await ownDraft(ctx, a.draft_id);
  if (ctx.dryRun) {
    const gap = (await draftPriceGaps(a.draft_id, ctx.ownerId)).find((g) => g.key === a.key);
    if (!gap) throw new RelayError(404, "That price is no longer in the draft.");
    return dry(`set Relay's price for ${gap.label} to ${a.value == null ? "nothing (gap left open)" : `£${a.value.toLocaleString("en-GB")}`}, shown in yellow until Alex accepts it.`);
  }
  await setFill(a.draft_id, ctx.ownerId, a.key, a.value, "relay");
  return after(a.draft_id, "Set the price.");
}

async function reprice(ctx: Ctx, a: DeskArgs["relay_reprice"]): Promise<string> {
  await ownDraft(ctx, a.draft_id);
  if (ctx.dryRun) return dry(`re-price the ${(await draftPriceGaps(a.draft_id, ctx.ownerId)).length} price gap(s) in ${a.draft_id}; prices Alex set stay.`);
  await priceDraft(a.draft_id, ctx.ownerId);
  return after(a.draft_id, "Re-priced it.");
}

async function ownDraft(ctx: Ctx, draftId: string): Promise<void> {
  const [row] = await queryPg<{ id: string }>("select id from relay_draft where id = $1 and item_id = $2 and state <> 'skipped'", [draftId, ctx.item.id]);
  if (!row) throw new RelayError(404, "That draft isn't on this email. Call relay_state for the ids.");
}

async function addTodo(ctx: Ctx, a: DeskArgs["relay_add_todo"]): Promise<string> {
  if (ctx.dryRun) return dry(`suggest the to-do "${a.title}"${a.detail ? ` (${a.detail})` : ""}.`);
  const [todo] = await queryPg<{ id: string }>(
    `insert into relay_todo (item_id, owner_id, title, detail, kind) select $1, $2::uuid, $3, $4, 'suggested'
     where not exists (select 1 from relay_todo where item_id = $1 and lower(title) = lower($3) and state in ('suggested', 'accepted')) returning id`,
    [ctx.item.id, ctx.ownerId, a.title, a.detail]);
  return todo ? `Suggested the to-do "${a.title}". Alex accepts it in Relay.` : "That to-do is already there.";
}

async function rememberLesson(ctx: Ctx, a: DeskArgs["relay_remember_lesson"]): Promise<string> {
  if (ctx.dryRun) return dry(`add "${a.text}" to Alex's email-writing lessons.`);
  // Only after Alex said yes in the chat (the brief says so): the lessons are his, in the one file every draft follows.
  return (await addLesson(a.text)) === "added" ? "Added to Alex's email-writing lessons. Every draft follows it from now on." : "His lessons already say that.";
}

async function ask(ctx: Ctx, a: DeskArgs["relay_ask"]): Promise<string> {
  if (ctx.dryRun) return dry(`ask Alex "${a.question}" with the options ${a.options.map((o) => `"${o}"`).join(", ")}. End your turn now.`);
  await addTurn(ctx.item.id, ctx.ownerId, "relay", a.question, "all", { ask: { question: a.question, options: a.options, run: ctx.runId } });
  return "Asked Alex. End your turn now; his answer comes as his next message.";
}

// ---------- the read tools ----------

/** One checked SELECT in a READ ONLY transaction with a statement timeout and a row cap. Postgres's error goes back to the desk. */
async function crmQuery(sql: string): Promise<string> {
  const checked = checkReadOnlySql(sql);
  if (!checked.ok) throw new RelayError(400, checked.why);
  try {
    const rows = await withPgTransaction(async (tx) => {
      await tx.query("set transaction read only");
      await tx.query(`set local statement_timeout = ${SQL_TIMEOUT_MS}`);
      return (await tx.query<Record<string, unknown>>(cappedSql(checked.sql))).rows;
    });
    return rowsAnswer(rows);
  } catch (error) {
    const pg = error as { code?: string; message?: string };
    if (typeof pg.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code)) throw new RelayError(400, `The database said: ${pg.message ?? pg.code}`);
    throw error;
  }
}

/** A marketplace listing or deal by id, read live from the platform. Read only. */
async function marketplaceRecord(id: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new RelayError(400, "That isn't a listing or deal id.");
  const db = getSupabaseAdminClient() as unknown as SupabaseClient;
  for (const table of ["listings", "deals"] as const) {
    const { data, error } = await db.from(table).select("*").eq("id", id).limit(1).abortSignal(AbortSignal.timeout(4000));
    if (error) {
      // A malformed id for that table (uuid columns) is just "not this table".
      if (/invalid input syntax/i.test(error.message)) continue;
      throw new RelayError(502, `Couldn't read the marketplace: ${error.message}`);
    }
    if (!data?.length) continue;
    if (table === "deals") return JSON.stringify({ kind: "deal", record: data[0] });
    // A listing comes with what has happened on it and its seller's setup, so a reply never asks Alex for either.
    const row = data[0] as ListingRow & { supplier_account_id: string | null };
    const signal = AbortSignal.timeout(5000);
    const [activity, seller] = await Promise.all([
      listingActivity(db, [row], signal).then((m) => m.get(row.id) ?? null).catch(() => null),
      row.supplier_account_id ? (async () => {
        const { data: acct } = await db.from("accounts").select("stripe_connect_status").eq("id", row.supplier_account_id!).limit(1).abortSignal(signal);
        return sellerSetup(db, row.supplier_account_id!, (acct?.[0] as { stripe_connect_status?: string } | undefined)?.stripe_connect_status ?? null, signal);
      })().catch(() => null) : Promise.resolve(null),
    ]);
    return JSON.stringify({ kind: "listing", record: row, activity, activity_text: activity ? activityText(activity) : "couldn't read activity", seller_setup: seller });
  }
  return `No marketplace listing or deal has the id ${id}.`;
}

/** The text of an email's attachments (relay_attachments.py, read-only Gmail), for an email Alex can see. */
async function attachmentText(ctx: Ctx, messageId: string): Promise<string> {
  const [m] = await queryPg<{ id: string; rfc_message_id: string | null; direction: string; from_email: string | null; to_emails: string[]; cc_emails: string[]; at: string }>(
    `select m.id, m.rfc_message_id, m.direction, m.from_email, coalesce(m.to_emails,'{}') as to_emails, coalesce(m.cc_emails,'{}') as cc_emails,
       coalesce(m.sent_at, m.accepted_at, m.created_at)::text as at
     from mail_message m where m.id = $1 and ${mailboxScopeSql("m", "$2")}`, [messageId, ctx.ownerId]);
  if (!m) throw new RelayError(404, "No email with that id that Alex can see. Use a message_id from relay_state.");
  const found = await threadFiles([{ ...m, has_files: true }]);
  if (!found) return "Couldn't read the attachments just now.";
  if (!found.files.length) return "That email has no attachments Relay can read.";
  return JSON.stringify(found);
}
