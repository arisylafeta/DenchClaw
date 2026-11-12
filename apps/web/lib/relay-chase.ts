import "server-only";
import { queryPg, withPgTransaction } from "./postgres";
import { chaseClock, MAX_CHASES } from "./chase-clock";
import { chaseDraft, chaseKey, verifyChase } from "./relay-chase-core";
import { stripQuoted } from "./relay-context-core";
import { replyIdentity, type ReplyIdentity } from "./relay-identity";
import { leadFirstName } from "./relay-lead-core";

/**
 * Chase drafts, the server part. The scan reads the chase clock for lead threads, deal threads, match asks and offers
 * Alex wrote last on and stores it on relay_item.chase; this pass (run only by the scan, through POST
 * /api/relay/internal/deals) turns a due chase into a draft in Review for a person to send. An inbox load only cancels
 * chase drafts they have answered (frontDoor in relay.ts); it never prepares one.
 *
 * - Nothing here sends. A chase is a mail draft (`draft`, the same mail CLI path every Relay draft takes) and a
 *   relay_draft row with origin 'predraft'; a person sends it from Review like any other draft.
 * - One open chase draft per thread (a unique index, migration 115), and each chase on the same unanswered message is
 *   prepared once (`chaseKey`), so a draft a person dropped does not come back.
 * - A reply from them skips the open chase draft and cancels a send-later on it (`cancelAnsweredChases`), and is checked
 *   again when Send is clicked (`chaseAnswered`). A reply counts when it was sent after our message the chase follows
 *   (relay_draft.chase_after), however late it synced.
 * - "Don't chase" (markDone with no_chase) stays as it was: the scan never turns that thread back into a chase.
 */

export type ChaseMailDraft = (d: { identity: ReplyIdentity; to: string[]; ccThread: boolean; thread: string | null; subject: string; body: string }) => Promise<string>;
/** relay_item.chase as the scan writes it. */
export type StoredChase = { state: "waiting" | "due" | "park"; chases: number; waited: number; next: number | null; due_on: string | null; since: string };
export type ChaseRun = { prepared: string[]; cancelled: number; refused: { item_id: string; reason: string }[] };

/** True while the send runner holds a claim on a draft's send (it is going out now); 20 minutes is the runner's own
 * reclaim time. Shared with relay.ts. Used bare against mail_message's own columns. */
export const SEND_CLAIMED_SQL = "coalesce((personalization->'scheduled_send'->>'claimed_at')::timestamptz > now() - interval '20 minutes', false)";

/** Chase drafts made per call; the next scan takes the rest. */
const BATCH = 3;
const KEY_SQL = `'[chase:' || (i.chase->>'next') || ' since ' || (i.chase->>'since') || ']'`;

/** A message from them on the chase's thread sent after our message the chase follows (`d` relay_draft, `i` relay_item). */
const ANSWERED_SQL = `exists (select 1 from mail_message m where m.thread_id = i.mail_thread_id and m.direction = 'inbound'
  and m.state in ('received', 'accepted') and coalesce(m.sent_at, m.accepted_at, m.created_at) > coalesce(d.chase_after, d.created_at))`;

/**
 * They replied after our message the chase follows: the open chase draft is skipped and any send-later on it is
 * cancelled, unless the send runner has already claimed it (it is going out; the runner's own reply check decides).
 * A chase already copied to Gmail drafts is marked gmail_copy_left: Relay has no way to delete that copy, so the email's
 * card says it is still there.
 */
export async function cancelAnsweredChases(ownerId: string): Promise<number> {
  const [row] = await queryPg<{ n: number }>(
    `with s as (
       update relay_draft d set state = 'skipped', gmail_copy_left = (d.state = 'gmail'), updated_at = now() from relay_item i
        where d.item_id = i.id and i.owner_id = $1::uuid and d.origin = 'predraft' and d.state in ('draft', 'gmail')
          and ${ANSWERED_SQL}
          and not exists (select 1 from mail_message where id = d.mail_message_id and (state <> 'draft' or ${SEND_CLAIMED_SQL}))
        returning d.mail_message_id),
     u as (update mail_message set personalization = personalization - 'scheduled_send'
        where id in (select mail_message_id from s) and state = 'draft' and personalization ? 'scheduled_send' and not ${SEND_CLAIMED_SQL} returning 1)
     select (select count(*) from s)::int as n`, [ownerId]);
  return row?.n ?? 0;
}

/**
 * At the Send click on a chase draft: true when they have replied since our message it follows. The draft is then
 * skipped (as cancelAnsweredChases would) and nothing is sent. False for any other draft.
 */
export async function chaseAnswered(draftId: string): Promise<boolean> {
  const rows = await queryPg<{ id: string }>(
    `update relay_draft d set state = 'skipped', updated_at = now() from relay_item i
      where d.id = $1 and d.item_id = i.id and d.origin = 'predraft' and d.state in ('draft', 'gmail') and ${ANSWERED_SQL}
      returning d.id`, [draftId]);
  return rows.length > 0;
}

type DueItem = { id: string; mail_thread_id: string | null; counterpart_name: string | null; counterpart_email: string | null; contact_type: string | null;
  bulk_listing_id: string | null; deal_label: string | null; headline: string; chase: StoredChase; key: string };
type Message = { direction: string; from_email: string | null; to_emails: string[]; cc_emails: string[]; subject: string | null; body_text: string | null; at: string; identity_key: string | null };

/** Names of the deal's other side: the parties of its counterparty offers and paired listings, and its matches. Never
 * the people on this thread themselves. */
export async function otherSideNames(listingId: string | null, own: (string | null)[]): Promise<string[]> {
  if (!listingId) return [];
  const rows = await queryPg<{ name: string | null }>(
    `select o.name from crm_bulk_offers o where o.role = 'counterparty' and (o.bulk_listing_id = $1 or o.counterpart_id = $1)
     union select c.name from crm_bulk_offers o join crm_companies c on c.id = o.company_id where o.role = 'counterparty' and (o.bulk_listing_id = $1 or o.counterpart_id = $1)
     union select l.party from crm_bulk_offers o join crm_bulk_listings l on l.id = case when o.bulk_listing_id = $1 then o.counterpart_id else o.bulk_listing_id end
       where o.role = 'counterparty' and (o.bulk_listing_id = $1 or o.counterpart_id = $1)
     union select m.name from crm_bulk_matches m where m.deal_id = $1
     union select d.party from crm_bulk_matches m join crm_bulk_listings d on d.id = m.deal_id where m.candidate_kind = 'listing' and m.candidate_id = $1`, [listingId]);
  const mine = new Set(own.filter((v): v is string => !!v).map((v) => v.trim().toLowerCase()));
  return [...new Set(rows.map((r) => (r.name ?? "").trim()).filter((name) => name.length >= 3 && !mine.has(name.toLowerCase())))];
}

/**
 * Due chases become drafts in Review. `draft` makes the mail draft (relay.ts passes createMailDraft); tests pass a stand-in.
 * Returns the items given a draft, how many open chase drafts a reply cancelled, and any chase the checks refused.
 */
export async function prepareChases(ownerId: string, deps: { draft: ChaseMailDraft; now?: Date }): Promise<ChaseRun> {
  const now = deps.now ?? new Date();
  const cancelled = await cancelAnsweredChases(ownerId);
  const due = await queryPg<DueItem>(
    `select i.id, i.mail_thread_id, i.counterpart_name, i.counterpart_email, i.contact_type, i.bulk_listing_id, i.deal_label, i.headline, i.chase, ${KEY_SQL} as key
     from relay_item i
     where i.owner_id = $1::uuid and i.status = 'open' and i.tab = 'follow' and i.chase->>'state' = 'due' and i.mail_thread_id is not null
       and (i.snooze_until is null or i.snooze_until <= now())
       and not exists (select 1 from relay_draft d where d.item_id = i.id and d.origin = 'predraft' and (d.state in ('draft', 'gmail') or d.source_note = ${KEY_SQL}))
     order by i.waiting_since nulls last limit ${BATCH}`, [ownerId]);
  const prepared: string[] = [];
  const refused: ChaseRun["refused"] = [];
  for (const item of due) {
    try {
      const reason = await prepareOne(item, deps.draft, now);
      if (reason) refused.push({ item_id: item.id, reason }); else prepared.push(item.id);
    } catch (error) {
      refused.push({ item_id: item.id, reason: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return { prepared, cancelled, refused };
}

/** One due chase. Returns why it was not drafted, or null when the draft is in Review. */
async function prepareOne(item: DueItem, draft: ChaseMailDraft, now: Date): Promise<string | null> {
  // The scan's reading may be minutes old: read the clock again, and the thread, before writing anything.
  const clock = chaseClock({ since: item.chase.since, chases: item.chase.chases }, now);
  if (clock.state !== "due" || clock.next == null || clock.next > MAX_CHASES) return `not due (${clock.state})`;
  const messages = await queryPg<Message>(
    `select direction, from_email, coalesce(to_emails,'{}') as to_emails, coalesce(cc_emails,'{}') as cc_emails, subject, body_text,
       coalesce(sent_at, accepted_at, created_at)::text as at, identity_key
     from mail_message where thread_id = $1 and state in ('received','accepted','sent','delivered','opened','clicked','replied')
     order by coalesce(sent_at, accepted_at, created_at) desc limit 12`, [item.mail_thread_id]);
  if (!messages.length) return "no messages on the thread";
  if (messages[0].direction === "inbound") return "they replied";
  const lastInbound = messages.find((m) => m.direction === "inbound");
  const to = (lastInbound?.from_email ?? item.counterpart_email ?? "").trim().toLowerCase();
  if (!to.includes("@") || to.endsWith("@rebattery.io")) return "no one to chase";
  const [deal] = item.bulk_listing_id ? await queryPg<{ text: string }>(
    "select concat_ws(' ', party, summary, quantity, location) as text from crm_bulk_listings where id = $1", [item.bulk_listing_id]) : [];
  const known = [item.headline, item.deal_label, item.counterpart_name, deal?.text,
    ...messages.flatMap((m) => [m.subject, stripQuoted(m.body_text ?? "")])].filter(Boolean).join("\n");
  const firstName = leadFirstName(item.counterpart_name, to, stripQuoted(lastInbound?.body_text ?? ""));
  const text = chaseDraft(clock.next, firstName, messages[0].subject ?? item.headline);
  const others = await otherSideNames(item.bulk_listing_id, [item.counterpart_name, firstName]);
  const check = verifyChase(text.body, known, others);
  if (!check.ok) {
    // Kept as a skipped row under the chase's key, so the same chase is not tried again on every scan.
    await queryPg(`insert into relay_draft (item_id, role, position, title, why, source_note, origin, state) values ($1, 'primary', 0, $2, $3, $4, 'predraft', 'skipped')`,
      [item.id, `Chase ${clock.next} of ${MAX_CHASES}`, `Not prepared: ${check.reason}`.slice(0, 300), item.key]);
    return `refused: ${check.reason}`;
  }
  // Claim first, so two passes at once make one draft: the unique index allows one open chase draft per thread. The draft
  // remembers when our message it follows was sent: any reply after that skips it.
  const [claim] = await queryPg<{ id: string }>(
    `insert into relay_draft (item_id, role, position, title, why, source_note, origin, agent_log, chase_after)
     values ($1, 'primary', 0, $2, $3, $4, 'predraft', $5::jsonb, $6::timestamptz)
     on conflict (item_id) where origin = 'predraft' and state in ('draft', 'gmail') do nothing returning id`,
    [item.id, `Chase ${clock.next} of ${MAX_CHASES}`, `No answer for ${clock.waited} working ${clock.waited === 1 ? "day" : "days"}`, item.key,
      JSON.stringify([`Prepared by Relay: chase ${clock.next} of ${MAX_CHASES} fell due on working day ${clock.waited}. Nothing is sent until you send it.`]),
      messages[0].at]);
  if (!claim) return "a chase draft is already open";
  let mailId: string;
  try {
    mailId = await draft({ identity: replyIdentity(messages, item.contact_type), to: [to], ccThread: true, thread: item.mail_thread_id, subject: text.subject, body: text.body });
  } catch (error) {
    await queryPg("delete from relay_draft where id = $1 and mail_message_id is null", [claim.id]);
    throw error;
  }
  await withPgTransaction(async (tx) => {
    await tx.query("update relay_draft set mail_message_id = $2, original_body = $3, updated_at = now() where id = $1", [claim.id, mailId, text.body]);
    await tx.query("update relay_item set status = 'review', updated_at = now() where id = $1 and status = 'open'", [item.id]);
  });
  return null;
}

/**
 * A sent chase on a thread that carries a stored match's ask (a supplier confirmation or a seller re-confirm) counts as
 * one of that match's chases (crm_bulk_matches.chases, at most three). Each chase draft counts once.
 */
export async function recordSentChases(draftIds: string[]): Promise<number> {
  if (!draftIds.length) return 0;
  const rows = await queryPg<{ id: string }>(
    `with sent as (select d.id as draft_id, m.thread_id from relay_draft d join mail_message m on m.id = d.mail_message_id
        where d.id = any($1) and d.origin = 'predraft' and m.state = 'accepted' and m.thread_id is not null)
     update crm_bulk_matches x set chases = least(x.chases + 1, 3), updated_at = now(),
         data = jsonb_set(x.data, '{chase_drafts}', coalesce(x.data->'chase_drafts', '[]'::jsonb) || to_jsonb(sent.draft_id))
       from sent
      where x.state = 'asked' and x.chases < 3 and not coalesce(x.data->'chase_drafts', '[]'::jsonb) ? sent.draft_id
        and exists (select 1 from mail_message ask where ask.id = x.data->>'open_draft_id' and ask.thread_id = sent.thread_id)
      returning x.id`, [draftIds]);
  return rows.length;
}
