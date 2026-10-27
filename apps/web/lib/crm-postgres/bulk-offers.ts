import { randomUUID } from "node:crypto";
import { queryPg } from "../postgres";

export const OFFER_STAGES = ["candidate", "offered", "contract_out", "signed", "invoiced", "paid", "complete", "declined", "lost"] as const;
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
  /** Who the next move is on: us (they spoke last, or we owe the step) or them (we spoke last). */
  waiting_on: "us" | "them" | null;
  waiting_since: string | null;
  updated_at: string;
  last_message_at: string | null;
  messages: number;
  /** True when the offer sits on another listing and points back at this one (counterpart_id); `name` is then that listing's party. */
  incoming: boolean;
  /** The other side's listing, when this offer is linked to one. */
  counterpart_id: string | null;
  /** For a mirrored (incoming) offer: the kind and a short label of the listing that holds it. */
  from_kind: "supply" | "demand" | null;
  from_label: string | null;
  /** Live listings on the opposite side that this offer could be linked to (only while it is unlinked). */
  link_options: { id: string; label: string }[];
  /** Inbox threads picked for this offer by hand. When set, only these threads are its email. */
  threads: string[];
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
  /** Where to open the exact email, call notes or document this entry came from. */
  href: string | null;
};

const selectOffers = (user: string) => `select o.id, o.bulk_listing_id as listing_id, o.role, o.person_id, o.company_id,
  case when o.bulk_listing_id <> $1 then coalesce((select b.party from crm_bulk_listings b where b.id = o.bulk_listing_id), o.name) else o.name end as name, o.contact, o.stage,
  o.declined_reason, o.wants, o.last_touch_on::text, o.last_touch_via, o.terms, o.data->>'next_step' as next_step,
  o.data->>'next_due' as next_due,
  case when o.data->>'waiting_on' in ('us','them') then o.data->>'waiting_on' end as waiting_on, o.data->>'waiting_since' as waiting_since, o.updated_at::text,
  nullif(greatest(
    (select max(a.occurred_at) from crm_bulk_listing_activity a where a.offer_id = o.id),
    (select max(coalesce(m.sent_at, m.created_at)) from mail_message m where m.crm_visible and (${user}::uuid is null or m.mailbox_owner_id = ${user}::uuid) and m.thread_id = any ((select jsonb_array_elements_text(coalesce(o.data->'threads', '[]'::jsonb)) union select l.thread_id from crm_bulk_thread_links l where l.offer_id = o.id and l.channel = 'mail' and l.state = 'confirmed')))
  ), '-infinity'::timestamptz)::text as last_message_at,
  ((select count(*) from crm_bulk_listing_activity a where a.offer_id = o.id)
   + (select count(*) from mail_message m where m.crm_visible and (${user}::uuid is null or m.mailbox_owner_id = ${user}::uuid) and m.thread_id = any ((select jsonb_array_elements_text(coalesce(o.data->'threads', '[]'::jsonb)) union select l.thread_id from crm_bulk_thread_links l where l.offer_id = o.id and l.channel = 'mail' and l.state = 'confirmed'))))::int as messages,
  array((select jsonb_array_elements_text(coalesce(o.data->'threads', '[]'::jsonb)) union select l.thread_id from crm_bulk_thread_links l where l.offer_id = o.id and l.channel = 'mail' and l.state = 'confirmed')) as threads
  , (o.bulk_listing_id <> $1) as incoming, o.counterpart_id
  , case when o.bulk_listing_id <> $1 then (select b.kind from crm_bulk_listings b where b.id = o.bulk_listing_id) end as from_kind
  , case when o.bulk_listing_id <> $1 then (select concat_ws(', ', b.party, nullif(left(coalesce(b.context->>'listing_title', b.summary), 60), '')) from crm_bulk_listings b where b.id = o.bulk_listing_id) end as from_label
  , case when o.bulk_listing_id = $1 and o.counterpart_id is null and o.role = 'counterparty' then coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'label', concat_ws(', ', c.party, nullif(left(coalesce(c.context->>'listing_title', c.summary), 60), ''))) order by c.id)
      from crm_bulk_listings c join crm_bulk_listings me on me.id = o.bulk_listing_id
      where c.status <> 'closed' and c.kind <> me.kind and c.id <> me.id
        and ((o.company_id is not null and c.company_id = o.company_id) or (o.person_id is not null and c.person_id = o.person_id))), '[]'::jsonb)
    else '[]'::jsonb end as link_options
  from crm_bulk_offers o`;

/** Threads on a listing: the people we have offered it to (or asked), newest touch first. Contacts on the owner's side are not threads. */
export async function listOffers(listingId: string, userId: string | null): Promise<Offer[]> {
  return queryPg<Offer>(
    `${selectOffers("$2")} where (o.bulk_listing_id = $1 or o.counterpart_id = $1) and o.role = 'counterparty'
     order by o.updated_at desc`, [listingId, userId]);
}

export async function getOffer(listingId: string, offerId: string, userId: string | null): Promise<Offer | null> {
  return (await queryPg<Offer>(`${selectOffers("$3")} where (o.bulk_listing_id = $1 or o.counterpart_id = $1) and o.id = $2`, [listingId, offerId, userId]))[0] ?? null;
}

export type OfferInput = { name: string; contact?: string | null; personId?: string | null; companyId?: string | null; wants?: string | null; stage?: OfferStage };

export class OfferConflict extends Error {
  constructor(message: string, readonly existingOfferId?: string) { super(message); this.name = "OfferConflict"; }
}

type LiveListing = { id: string; kind: "supply" | "demand"; label: string };

/** Live listings on the opposite side of `listingId` that belong to the same company or person as the offer. */
export async function linkCandidates(listingId: string, companyId: string | null, personId: string | null): Promise<LiveListing[]> {
  if (!companyId && !personId) return [];
  return queryPg<LiveListing>(
    `select c.id, c.kind, concat_ws(', ', c.party, nullif(left(coalesce(c.context->>'listing_title', c.summary), 60), '')) as label
     from crm_bulk_listings c join crm_bulk_listings me on me.id = $1
     where c.status <> 'closed' and c.kind <> me.kind and c.id <> me.id
       and (($2::text is not null and c.company_id = $2) or ($3::text is not null and c.person_id = $3))
     order by c.id`, [listingId, companyId, personId]);
}

/** The existing offer for this pairing, in either direction. */
async function pairOffer(a: string, b: string): Promise<string | null> {
  const [row] = await queryPg<{ id: string }>(
    `select id from crm_bulk_offers where role = 'counterparty'
       and ((bulk_listing_id = $1 and counterpart_id = $2) or (bulk_listing_id = $2 and counterpart_id = $1)) limit 1`, [a, b]);
  return row?.id ?? null;
}

/** Stores the offer once, on the listing it was made on. When the other party has exactly one live listing of the opposite
 *  kind the two are linked at once, so the offer shows on both sides; with several it stays unlinked and the caller can ask which. */
export async function addOffer(listingId: string, input: OfferInput & { counterpartId?: string | null }): Promise<Offer> {
  const id = `bof_${randomUUID()}`;
  let counterpartId = input.counterpartId ?? null;
  if (counterpartId) {
    const [t] = await queryPg<{ ok: boolean }>(
      `select (t.status <> 'closed' and t.kind <> me.kind) as ok from crm_bulk_listings t, crm_bulk_listings me where t.id = $2 and me.id = $1`, [listingId, counterpartId]);
    if (!t?.ok) throw new OfferConflict("Link to a live listing on the opposite side.");
  } else {
    const found = await linkCandidates(listingId, input.companyId ?? null, input.personId ?? null);
    if (found.length === 1) counterpartId = found[0].id;
  }
  if (counterpartId) {
    const existing = await pairOffer(listingId, counterpartId);
    if (existing) throw new OfferConflict("This pairing already has an offer.", existing);
  }
  await queryPg(
    `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, wants, stage, counterpart_id)
     values ($1, $2, 'counterparty', $3, $4, $5, $6, $7, $8, $9)`,
    [id, listingId, input.personId ?? null, input.companyId ?? null, input.name.trim(), input.contact ?? null, input.wants ?? null, input.stage ?? "candidate", counterpartId]);
  return (await getOffer(listingId, id, null))!;
}

/** Links an unlinked offer to a live listing on the opposite side, or clears the link (null). */
export async function linkOffer(listingId: string, offerId: string, targetId: string | null, actorUserId: string | null): Promise<Offer | null> {
  const current = await getOffer(listingId, offerId, actorUserId);
  if (!current || current.incoming) return null;
  if (targetId) {
    const [t] = await queryPg<{ ok: boolean }>(
      `select (t.status <> 'closed' and t.kind <> me.kind) as ok from crm_bulk_listings t, crm_bulk_listings me where t.id = $2 and me.id = $1`, [listingId, targetId]);
    if (!t?.ok) throw new OfferConflict("Link to a live listing on the opposite side.");
    const existing = await pairOffer(listingId, targetId);
    if (existing && existing !== offerId) throw new OfferConflict("This pairing already has an offer.", existing);
  }
  await queryPg(
    `update crm_bulk_offers set counterpart_id = $3, data = data || jsonb_build_object('previous_counterpart_id', counterpart_id), updated_at = now()
     where id = $2 and bulk_listing_id = $1`, [listingId, offerId, targetId]);
  await queryPg(
    `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, data, actor_user_id)
     values ($1, $2, $3, 'status', $4, $5::jsonb, $6)`,
    [listingId, offerId, current.person_id, `${current.name ?? "Offer"} · ${targetId ? "linked to " + targetId : "unlinked"}`, JSON.stringify({ from: current.counterpart_id, counterpart_id: targetId }), actorUserId]);
  return getOffer(listingId, offerId, actorUserId);
}

export type OfferPatch = { stage?: OfferStage; nextStep?: string | null; nextDue?: string | null; wants?: string | null; terms?: OfferTerms; declinedReason?: string | null };

export async function updateOffer(listingId: string, offerId: string, patch: OfferPatch, actorUserId: string | null): Promise<Offer | null> {
  const current = await getOffer(listingId, offerId, actorUserId);
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
     where id = $2 and bulk_listing_id = $1`,
    [current.listing_id, offerId, "stage" in patch, patch.stage ?? null, "wants" in patch, patch.wants ?? null,
      "terms" in patch, JSON.stringify(patch.terms ?? {}), "declinedReason" in patch, patch.declinedReason ?? null, JSON.stringify(data)]);
  if (patch.stage && patch.stage !== current.stage) {
    await queryPg(
      `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, data, actor_user_id)
       values ($1, $2, $3, 'status', $4, $5::jsonb, $6)`,
      [current.listing_id, offerId, current.person_id, `${current.name ?? "Offer"} · ${STAGE_LABEL[patch.stage]}`, JSON.stringify({ from: current.stage, stage: patch.stage }), actorUserId]);
  }
  return getOffer(listingId, offerId, actorUserId);
}

export const STAGE_LABEL: Record<OfferStage, string> = {
  candidate: "Candidate", offered: "Offered", contract_out: "Contract out", signed: "Signed", invoiced: "Invoice out", paid: "Paid",
  complete: "Complete", declined: "Declined", lost: "Lost",
};

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** The full thread: logged activity on this offer, plus email (the signed-in user's mailbox) and WhatsApp with the same person. Newest first. */
export async function offerThread(offer: Offer, userId: string | null): Promise<ThreadEntry[]> {
  const email = offer.contact?.match(EMAIL)?.[0]?.toLowerCase() ?? null;
  const activity = await queryPg<{ id: string; kind: string; title: string; body: string | null; at: string; ref_id: string | null }>(
    `select id::text, kind, title, body, occurred_at::text as at, ref_id from crm_bulk_listing_activity where offer_id = $1 order by occurred_at desc limit 100`, [offer.id]);
  const mail = offer.threads.length || offer.person_id || email ? await queryPg<{ id: string; direction: "inbound" | "outbound"; subject: string | null; body: string | null; at: string; thread_id: string | null }>(
    `select m.id, m.direction, m.subject, coalesce(m.body_preview, left(m.body_text, 600)) as body,
       coalesce(m.sent_at, m.created_at)::text as at, m.thread_id
     from mail_message m
     where m.crm_visible and ($3::uuid is null or m.mailbox_owner_id = $3::uuid)
       and (case when cardinality($4::text[]) > 0 then m.thread_id = any ($4::text[]) else ((m.person_id is not null and m.person_id = $1) or ($2::text is not null and (lower(m.from_email) = $2 or lower(m.recipient_email) = $2 or $2 = any (select lower(x) from unnest(m.to_emails) x)))) end)
     order by coalesce(m.sent_at, m.created_at) desc limit 60`, [offer.person_id, email, userId, offer.threads]) : [];
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
    ...activity.filter((a) => !covered(a)).map((a) => ({ id: `a${a.id}`, channel: channelOf(a.kind), direction: null, title: a.title, body: a.body, at: a.at, ref: a.ref_id, href: a.ref_id && /^(https?:\/\/|\/)/.test(a.ref_id) ? a.ref_id : null })),
    ...mail.map((m) => ({ id: `m${m.id}`, channel: "mail" as const, direction: m.direction, title: m.subject ?? "(no subject)", body: m.body, at: m.at, ref: m.thread_id, href: m.thread_id ? `/?crm=inbox&view=conversations&thread=${encodeURIComponent(m.thread_id)}&crmOnly=false` : null })),
    ...chat.map((c) => ({ id: `w${c.id}`, channel: "whatsapp" as const, direction: c.direction, title: c.direction === "outbound" ? "You" : offer.name ?? "Them", body: c.body, at: c.at, ref: null, href: null })),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** A note, call or other touch on this thread. Also stamps the offer's last touch. */
export async function addThreadEntry(listingId: string, offer: Offer, input: { kind: "note" | "call" | "quote" | "mail" | "whatsapp"; title: string; body?: string | null }, actorUserId: string | null) {
  await queryPg(
    `insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, body, actor_user_id)
     values ($1, $2, $3, $4, $5, $6, $7)`, [offer.listing_id, offer.id, offer.person_id, input.kind, input.title.trim(), input.body ?? null, actorUserId]);
  await queryPg(`update crm_bulk_offers set last_touch_on = current_date, last_touch_via = $2, updated_at = now() where id = $1`, [offer.id, input.kind]);
}
