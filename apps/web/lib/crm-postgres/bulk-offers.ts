import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";

export const OFFER_STAGES = ["to_contact", "teaser_sent", "specs_nda", "bid_in", "loi", "won", "declined", "lost"] as const;
export type OfferStage = typeof OFFER_STAGES[number];

export type OfferTerms = { amount?: number; unit?: string; currency?: string; firmness?: string; delivery_terms?: string; payment_terms?: string; expires_on?: string };

export type Offer = {
  id: string;
  listing_id: string;
  role: "principal" | "contact" | "counterparty";
  person_id: string | null;
  company_id: string | null;
  name: string | null;
  contact: string | null;
  stage: OfferStage | null;
  declined_reason: string | null;
  wants: string | null;
  last_touch_on: string | null;
  last_touch_via: string | null;
  terms: OfferTerms;
  next_step: string | null;
  next_due: string | null;
  updated_at: string;
  last_message_at: string | null;
  messages: number;
};

/** One line in a thread: an email, WhatsApp message, call, bid, note or stage change. */
export type ThreadEntry = {
  id: string;
  channel: "mail" | "whatsapp" | "call" | "quote" | "note" | "status" | "document" | "other";
  direction: "inbound" | "outbound" | null;
  title: string;
  body: string | null;
  at: string;
  ref: string | null;
};

const SELECT = `select o.id, o.bulk_listing_id as listing_id, o.role, o.person_id, o.company_id, o.name, o.contact, o.stage,
  o.declined_reason, o.wants, o.last_touch_on::text, o.last_touch_via, o.terms, o.data->>'next_step' as next_step,
  o.data->>'next_due' as next_due, o.updated_at::text,
  (select max(a.occurred_at)::text from crm_bulk_listing_activity a where a.offer_id = o.id) as last_message_at,
  (select count(*)::int from crm_bulk_listing_activity a where a.offer_id = o.id) as messages
  from crm_bulk_offers o`;

/** Threads on a listing: the people we have offered it to (or asked), newest touch first. Contacts on the owner's side are not threads. */
export async function listOffers(listingId: string): Promise<Offer[]> {
  return queryPg<Offer>(
    `${SELECT} where o.bulk_listing_id = $1 and o.role = 'counterparty'
     order by coalesce((select max(a.occurred_at) from crm_bulk_listing_activity a where a.offer_id = o.id), o.updated_at) desc`, [listingId]);
}

export async function getOffer(listingId: string, offerId: string): Promise<Offer | null> {
  return (await queryPg<Offer>(`${SELECT} where o.bulk_listing_id = $1 and o.id = $2`, [listingId, offerId]))[0] ?? null;
}

export type OfferInput = { name: string; contact?: string | null; personId?: string | null; companyId?: string | null; wants?: string | null; stage?: OfferStage };

export async function addOffer(listingId: string, input: OfferInput): Promise<Offer> {
  const id = `bof_${randomUUID()}`;
  await queryPg(
    `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, wants, stage)
     values ($1, $2, 'counterparty', $3, $4, $5, $6, $7, $8)`,
    [id, listingId, input.personId ?? null, input.companyId ?? null, input.name.trim(), input.contact ?? null, input.wants ?? null, input.stage ?? "to_contact"]);
  return (await getOffer(listingId, id))!;
}

export type OfferPatch = { stage?: OfferStage; nextStep?: string | null; nextDue?: string | null; wants?: string | null; terms?: OfferTerms; declinedReason?: string | null };

export async function updateOffer(listingId: string, offerId: string, patch: OfferPatch, actorUserId: string | null): Promise<Offer | null> {
  const current = await getOffer(listingId, offerId);
  if (!current) return null;
  const data: Record<string, unknown> = {};
  if ("nextStep" in patch) data.next_step = patch.nextStep?.trim() || null;
  if ("nextDue" in patch) data.next_due = patch.nextDue || null;
  await queryPg(
    `update crm_bulk_offers set
       stage = case when $3::boolean then $4 else stage end,
       wants = case when $5::boolean then $6 else wants end,
       terms = case when $7::boolean then $8::jsonb else terms end,
       declined_reason = case when $9::boolean then $10 else declined_reason end,
       data = (data || $11::jsonb) - coalesce((select array_agg(k) from jsonb_each_text($11::jsonb) e(k, v) where v is null), '{}'::text[]),
       updated_at = now()
     where bulk_listing_id = $1 and id = $2`,
    [listingId, offerId, "stage" in patch, patch.stage ?? null, "wants" in patch, patch.wants ?? null,
      "terms" in patch, JSON.stringify(patch.terms ?? {}), "declinedReason" in patch, patch.declinedReason ?? null, JSON.stringify(data)]);
  if (patch.stage && patch.stage !== current.stage) {
    await queryPg(
      `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, data, actor_user_id)
       values ($1, $2, $3, 'status', $4, $5::jsonb, $6)`,
      [listingId, offerId, current.person_id, `${current.name ?? "Offer"} · ${STAGE_LABEL[patch.stage]}`, JSON.stringify({ from: current.stage, stage: patch.stage }), actorUserId]);
  }
  return getOffer(listingId, offerId);
}

export const STAGE_LABEL: Record<OfferStage, string> = {
  to_contact: "To contact", teaser_sent: "Sent", specs_nda: "Specs and NDA", bid_in: "Bid in", loi: "LOI", won: "Won", declined: "Declined", lost: "Lost",
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The full thread: logged activity on this offer, plus email (the signed-in user's mailbox) and WhatsApp with the same person. Newest first. */
export async function offerThread(offer: Offer, userId: string | null): Promise<ThreadEntry[]> {
  const email = offer.contact?.match(EMAIL)?.[0]?.toLowerCase() ?? null;
  const activity = await queryPg<{ id: string; kind: string; title: string; body: string | null; at: string; ref_id: string | null }>(
    `select id::text, kind, title, body, occurred_at::text as at, ref_id from crm_bulk_listing_activity where offer_id = $1 order by occurred_at desc limit 100`, [offer.id]);
  const mail = offer.person_id || email ? await queryPg<{ id: string; direction: "inbound" | "outbound"; subject: string | null; body: string | null; at: string; thread_id: string | null }>(
    `select m.id, m.direction, m.subject, coalesce(m.body_preview, left(m.body_text, 600)) as body,
       coalesce(m.sent_at, m.created_at)::text as at, m.thread_id
     from mail_message m
     where m.crm_visible and ($3::uuid is null or m.mailbox_owner_id = $3::uuid)
       and ((m.person_id is not null and m.person_id = $1) or ($2::text is not null and (lower(m.from_email) = $2 or lower(m.recipient_email) = $2 or $2 = any (select lower(x) from unnest(m.to_emails) x))))
     order by coalesce(m.sent_at, m.created_at) desc limit 40`, [offer.person_id, email, userId]) : [];
  const chat = offer.person_id ? await queryPg<{ id: string; direction: "inbound" | "outbound" | null; body: string | null; at: string }>(
    `select wm.id, wm.direction, wm.body, wm.occurred_at::text as at
     from whatsapp_message wm
     join whatsapp_thread wt on wt.account_id = wm.account_id and wt.id = wm.thread_id
     join whatsapp_identity_link il on il.account_id = wt.account_id and il.identity_id = wt.identity_id and il.valid_to is null
     where il.person_id = $1 and wm.deleted_at is null and wm.body is not null and wm.occurred_at is not null
     order by wm.occurred_at desc limit 40`, [offer.person_id]) : [];
  const channelOf = (kind: string): ThreadEntry["channel"] =>
    kind === "mail" || kind === "whatsapp" || kind === "call" || kind === "quote" || kind === "note" || kind === "status" || kind === "document" ? kind : "other";
  // A logged mail summary points at an inbox thread. When the real messages of that thread are shown, the summary is History's job, not the thread's.
  const shownThreads = new Set(mail.map((m) => m.thread_id).filter((t): t is string => !!t));
  const covered = (a: { kind: string; ref_id: string | null }) => a.kind === "mail" && !!a.ref_id && [...shownThreads].some((t) => a.ref_id!.includes(t));
  const entries: ThreadEntry[] = [
    ...activity.filter((a) => !covered(a)).map((a) => ({ id: `a${a.id}`, channel: channelOf(a.kind), direction: null, title: a.title, body: a.body, at: a.at, ref: a.ref_id })),
    ...mail.map((m) => ({ id: `m${m.id}`, channel: "mail" as const, direction: m.direction, title: m.subject ?? "(no subject)", body: m.body, at: m.at, ref: m.thread_id })),
    ...chat.map((c) => ({ id: `w${c.id}`, channel: "whatsapp" as const, direction: c.direction, title: c.direction === "outbound" ? "You" : offer.name ?? "Them", body: c.body, at: c.at, ref: null })),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A note, call or other touch on this thread. Also stamps the offer's last touch. */
export async function addThreadEntry(listingId: string, offer: Offer, input: { kind: "note" | "call" | "quote" | "mail" | "whatsapp"; title: string; body?: string | null }, actorUserId: string | null) {
  await queryPg(
    `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, body, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7)`, [listingId, offer.id, offer.person_id, input.kind, input.title.trim(), input.body ?? null, actorUserId]);
  await queryPg(`update crm_bulk_offers set last_touch_on = current_date, last_touch_via = $2, updated_at = now() where id = $1`, [offer.id, input.kind]);
}
