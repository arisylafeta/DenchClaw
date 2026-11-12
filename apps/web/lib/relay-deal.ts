import "server-only";
import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "./postgres";
import { askedFields, dealFromCard } from "./relay-deal-core";
import { AUTO_DEAL_UPDATE_DAYS, autoDealUpdateOn, CHECK_FIELD, opensDeal, QUALIFY_KEYS, checklistRoute } from "./relay-front-door";
import { isPersonalDomain } from "./relay-identity";
import { assembleLead, cleanLeadState, leadRoute, type LeadData } from "./relay-lead-core";

/**
 * The front door, the server part: what happens to a lead after Alex sends the first reply, and to a deal after they
 * answer. Nothing here sends mail or runs a model.
 *
 * - A bulk lead's deal opens when the reply has gone (`settleSentCards`), not on the click: Undo inside the hold leaves
 *   the card "queued" with no accepted email, so no deal is ever made for an email that did not go.
 * - A new reply on a thread linked to a deal queues "Update deal from this reply" by itself (`queueReplyUpdates`).
 * - A Matcha result that fails the fit check leaves no new, unlinked deal behind (`closeUnfitListing`).
 * - The checklist state behind Qualified (`markAsked`, `setCheckState`, `setQualifiedTick`).
 */

export const DEAL_NOTE = "[deal:";
/** A Create or Update deal job older than this is treated as dead (relay.ts marks it failed). */
export const JOB_STALE_MINUTES = 25;
const ACTOR = "relay";
/** How many sent cards, or automatic updates, one call handles; the next poll takes the rest. */
const BATCH = 5;

type CardStored = { lead: LeadData; who: { name: string; company: string | null; email: string; at: string } };

/** Marks checklist items as asked in the email sent at `at`: one more ask each. Rows that hold only state are made. */
export async function markAsked(tx: PgTransaction, listingId: string, fieldKeys: string[], at: string): Promise<void> {
  if (!fieldKeys.length) return;
  await tx.query(
    `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, asked_at, asked_count)
     select $1, k, null, 'missing', 'never', $3::timestamptz, 1 from unnest($2::text[]) k
     on conflict (bulk_listing_id, field_key) do update set asked_at = excluded.asked_at, asked_count = crm_bulk_listing_fields.asked_count + 1`,
    [listingId, fieldKeys, at]);
}

const DEAL_BUSY = `select 1 from relay_job where item_id = $1 and left(note, 6) = '${DEAL_NOTE}' and status in ('queued','running','ready','finalising')
  and created_at > now() - interval '${JOB_STALE_MINUTES} minutes' limit 1`;

type SentCard = { id: string; item_id: string; message_id: string; data: Partial<CardStored>; state: unknown; mail_id: string; sent_at: string; mail_thread_id: string | null; gmail_thread_id: string };

/**
 * Cards whose reply has gone: each is marked sent, its route kept, and for a bulk or recycling lead the deal opened from
 * the card's facts (relay-deal-core) with the sender as its contact, linked to the thread, owned by Alex. A lead under
 * the bulk line opens nothing. One claim per card (status queued to sent), under the same lock as Create deal.
 */
export async function settleSentCards(ownerId: string): Promise<{ sent: number; opened: string[] }> {
  const rows = await queryPg<SentCard>(
    `select c.id, c.item_id, c.message_id, c.data, c.state, m.id as mail_id, coalesce(m.accepted_at, m.sent_at, m.updated_at)::text as sent_at,
       i.mail_thread_id, i.gmail_thread_id
     from relay_card c join relay_item i on i.id = c.item_id join relay_draft d on d.id::text = c.draft_id join mail_message m on m.id = d.mail_message_id
     where c.owner_id = $1::uuid and c.status = 'queued' and m.state = 'accepted' order by c.updated_at limit ${BATCH}`, [ownerId]);
  const opened: string[] = [];
  let sent = 0;
  for (const row of rows) {
    try {
      const id = await withPgTransaction((tx) => settleOne(tx, row));
      sent++;
      if (id) opened.push(id);
    } catch (error) {
      // Recorded on the card; the email went, so the card is not offered again.
      console.error("relay card settle", error);
      await queryPg("update relay_card set status = 'sent', error = $2, updated_at = now() where id = $1 and status = 'queued'",
        [row.id, "The reply went, but Relay couldn't open the deal. Use Create deal on the email."]).catch(() => undefined);
    }
  }
  return { sent, opened };
}

async function settleOne(tx: PgTransaction, row: SentCard): Promise<string | null> {
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`relay-deal:${row.item_id}`]);
  await tx.query("select set_config('bulk.actor', $1, true)", [ACTOR]);
  const claim = await tx.query("update relay_card set status = 'sent', updated_at = now() where id = $1 and status = 'queued' returning id", [row.id]);
  if (!claim.rowCount) return null;
  const { lead, who } = row.data as CardStored;
  if (!lead || !who) return null;
  const state = cleanLeadState(row.state, lead);
  const route = leadRoute(lead, state);
  const asked = assembleLead(lead, state, {}).asks.filter((a) => a.on).map((a) => a.key);
  const kind = lead.side === "buyer" ? "demand" : "supply";
  const { rows: [item] } = await tx.query<{ bulk_listing_id: string | null }>("select bulk_listing_id from relay_item where id = $1 for update", [row.item_id]);
  let listingId = item?.bulk_listing_id ?? null;
  let created = false;
  if (listingId) {
    await tx.query("update crm_bulk_listings set route = coalesce(route, $2), route_reason = coalesce(route_reason, $3) where id = $1",
      [listingId, route.route, route.reason.slice(0, 300)]);
  } else {
    const have = new Set(lead.facts.map((f) => f.key));
    const busy = (await tx.query(DEAL_BUSY, [row.item_id])).rowCount;
    if (!busy && opensDeal(route, { what: have.has("what"), how_many: have.has("how_many") })) {
      listingId = await openDeal(tx, row, lead, who, route, asked);
      created = true;
    }
  }
  if (listingId) await markAsked(tx, listingId, askedFields(kind, asked), row.sent_at);
  await tx.query("update relay_card set data = data || $2::jsonb where id = $1",
    [row.id, JSON.stringify({ sent: { route, deal_id: listingId, opened: created, asked, at: row.sent_at } })]);
  return created ? listingId : null;
}

/** The insert Matcha's Create deal would make, from the card. Returns the listing id. */
async function openDeal(tx: PgTransaction, row: SentCard, lead: LeadData, who: CardStored["who"], route: ReturnType<typeof leadRoute>, asked: string[]): Promise<string> {
  const email = who.email.toLowerCase().trim();
  const domain = email.split("@")[1] ?? "";
  const deal = dealFromCard({ lead, who, route, asked, sentAt: new Date(row.sent_at) });
  // An existing person and company when the CRM has them; never a new one (intake.md, Relay buttons).
  const { rows: [person] } = await tx.query<{ id: string; company_id: string | null }>("select id, company_id from crm_people where lower(email) = $1 order by id limit 1", [email]);
  const { rows: [company] } = await tx.query<{ id: string; name: string }>(
    `select id, name from crm_companies where id = $1 or ($1::text is null and $2 <> '' and lower(domain) = $2) order by id limit 1`,
    [person?.company_id ?? null, isPersonalDomain(domain) ? "" : domain]);
  const party = (company?.name || who.company || who.name || email).slice(0, 200);
  const id = `${deal.kind === "demand" ? "btd" : "bt"}_${randomUUID()}`;
  const observed = (who.at || row.sent_at).slice(0, 10);
  const { rows: [inserted] } = await tx.query<{ id: string }>(
    `insert into crm_bulk_listings (id, kind, party, company_id, person_id, email, summary, quantity, location, clear_by, status, observed_on,
       source_kind, source_id, source_thread, source_label, spec, context, next_action, next_due, waiting_on, waiting_since, route, route_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, 'open', $11::date, 'email', $12, $13, $14, $15::jsonb, $16::jsonb, $17, $18::date, 'them', $19::date, $20, $21)
     on conflict (kind, source_kind, source_id) where source_id is not null do nothing returning id`,
    [id, deal.kind, party, company?.id ?? null, person?.id ?? null, email, deal.summary.slice(0, 500), deal.quantity, deal.location, deal.clear_by, observed,
      row.message_id, row.gmail_thread_id, `Gmail · ${email}`, JSON.stringify(deal.spec), JSON.stringify(deal.context),
      deal.next_action, deal.next_due, row.sent_at.slice(0, 10), route.route, route.reason.slice(0, 300)]);
  if (!inserted) throw new Error("A deal from this email is already in the CRM.");
  const source = `Email from ${email}`;
  for (const f of deal.fields) {
    await tx.query(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, source_label, source_date)
       values ($1, $2, $3, 'unverified', $4, $5, $6::date) on conflict (bulk_listing_id, field_key) do nothing`,
      [id, f.key, f.value, f.visibility, source, observed]);
  }
  // The sender, and anyone from their company on the thread, as the deal's contacts. The listing's person or email stays the main one.
  const people = await tx.query<{ email: string }>(
    `select distinct lower(a) as email from mail_message m, unnest(array[m.from_email] || coalesce(m.to_emails,'{}') || coalesce(m.cc_emails,'{}')) a
      where m.thread_id = $1 and $2 <> '' and split_part(lower(a), '@', 2) = $2 and lower(a) <> $3`, [row.mail_thread_id, isPersonalDomain(domain) ? "" : domain, email]);
  for (const contact of [email, ...people.rows.map((p) => p.email)]) {
    await tx.query(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact)
       select $1, $2, 'contact', p.id, coalesce(p.company_id, $5), coalesce(p.full_name, $4), $3
       from (select 1) one left join lateral (select id, company_id, full_name from crm_people where lower(email) = $3 order by id limit 1) p on true
       where not exists (select 1 from crm_bulk_offers o where o.bulk_listing_id = $2 and o.role = 'contact' and lower(o.contact) = $3)`,
      [`btc_${randomUUID()}`, id, contact, contact === email ? who.name || email : contact, company?.id ?? null]);
  }
  await tx.query(
    `insert into crm_bulk_listing_activity (bulk_listing_id, person_id, kind, title, body, ref_kind, ref_id, data, occurred_at)
     values ($1, $2, 'mail', $3, $4, 'email', $5, $6::jsonb, $7::timestamptz)`,
    [id, person?.id ?? null, deal.story.title, deal.story.body, row.mail_id, JSON.stringify(deal.story.data), row.sent_at]);
  if (row.mail_thread_id) {
    await tx.query(
      `insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, confidence, state, reason, labelled_by)
       values ('mail', $1, $2, 'high', 'proposed', 'Deal opened from the lead card when the first reply went', 'relay-card')
       on conflict (channel, thread_id, bulk_listing_id, (coalesce(offer_id, ''))) do nothing`, [row.mail_thread_id, id]);
  }
  await tx.query("update relay_item set bulk_listing_id = $2, deal_label = $3, updated_at = now() where id = $1", [row.item_id, id, deal.title.slice(0, 120)]);
  return id;
}

/** Counts the checklist items a sent "Draft the ask" email asked for (relay_draft.ask_keys), once per draft. */
export async function recordSentAsks(draftIds: string[]): Promise<void> {
  if (!draftIds.length) return;
  await withPgTransaction(async (tx) => {
    const { rows } = await tx.query<{ ask_keys: string[]; listing_id: string | null; kind: string | null; at: string }>(
      `with old as (select d.id, d.ask_keys, d.item_id, coalesce(d.sent_at, now())::text as at from relay_draft d
          where d.id = any($1) and d.ask_keys <> '{}' and d.state = 'sent' for update),
        cleared as (update relay_draft d set ask_keys = '{}' from old where d.id = old.id returning d.id)
       select old.ask_keys, i.bulk_listing_id as listing_id, b.kind, old.at from old join cleared using (id)
         join relay_item i on i.id = old.item_id left join crm_bulk_listings b on b.id = i.bulk_listing_id`, [draftIds]);
    for (const r of rows) {
      if (!r.listing_id || !r.kind) continue;
      const kind = r.kind === "demand" ? "demand" : "supply";
      await markAsked(tx, r.listing_id, [...new Set(r.ask_keys.map((k) => CHECK_FIELD[kind][k]).filter(Boolean))], r.at);
    }
  });
}

/**
 * New replies on threads linked to a deal: "Update deal from this reply" is queued for each by itself, through `start`
 * (relay.ts startDealJob: one job per email at a time, the same advisory lock and 25-minute stale rule). Only the newest
 * message counts, it must be from them and from the last AUTO_DEAL_UPDATE_DAYS days, and no deal job may have started
 * since it arrived. Off when RELAY_AUTO_DEAL_UPDATE=off.
 */
export async function queueReplyUpdates(ownerId: string, start: (itemId: string) => Promise<void>, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  if (!autoDealUpdateOn(env)) return [];
  const due = await queryPg<{ id: string }>(
    `select i.id from relay_item i
       join lateral (select m.direction, coalesce(m.sent_at, m.accepted_at, m.created_at) as at from mail_message m
         where m.thread_id = i.mail_thread_id and m.state in ('received','accepted') order by coalesce(m.sent_at, m.accepted_at, m.created_at) desc limit 1) n on true
       join crm_bulk_listings b on b.id = i.bulk_listing_id and b.status <> 'closed'
      where i.owner_id = $1::uuid and i.status = 'open' and n.direction = 'inbound' and n.at > now() - interval '${AUTO_DEAL_UPDATE_DAYS} days'
        and not exists (select 1 from relay_job j where j.item_id = i.id and left(j.note, 6) = '${DEAL_NOTE}' and j.created_at >= n.at)
      order by n.at limit ${BATCH}`, [ownerId]);
  const queued: string[] = [];
  for (const { id } of due) {
    try { await start(id); queued.push(id); } catch { /* busy or gone: the next poll looks again */ }
  }
  return queued;
}

/**
 * A Create or Update deal job named a deal that does not fit its email. If that job itself made the listing (created
 * after the job started, by Matcha's own report) and nothing else uses it, it is closed with a Story row saying why,
 * not deleted, so the record of what Matcha did stays and a person can reopen it. Returns true when it closed one.
 */
export async function closeUnfitListing(listingId: string, jobCreatedAt: string, jobId: string): Promise<boolean> {
  return withPgTransaction(async (tx) => {
    await tx.query("select set_config('bulk.actor', $1, true)", [ACTOR]);
    const { rows } = await tx.query<{ id: string }>(
      `update crm_bulk_listings b set status = 'closed', closed_reason = 'other', updated_at = now()
        where b.id = $1 and b.status <> 'closed' and b.created_at >= $2::timestamptz
          and not exists (select 1 from relay_item i where i.bulk_listing_id = b.id)
          and not exists (select 1 from crm_bulk_thread_links l where l.bulk_listing_id = b.id and l.state = 'confirmed')
          and not exists (select 1 from crm_bulk_offers o where o.role = 'counterparty' and (o.bulk_listing_id = b.id or o.counterpart_id = b.id))
        returning b.id`, [listingId, jobCreatedAt]);
    if (!rows.length) return false;
    await tx.query(
      `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data) values ($1, 'note', $2, $3, $4::jsonb)`,
      [listingId, "Closed by Relay: Matcha opened it for an email it does not fit",
        "Matcha's job created this deal, but it is not this email's deal (not linked to the thread, and the sender does not own it), so Relay linked nothing and closed it. Reopen it if it is a real deal.",
        JSON.stringify({ relay_job: jobId })]);
    return true;
  });
}

// ---------- checklist state ----------

/** The person checked an item, or marked that they cannot provide it (or took either back). */
export async function setCheckState(listingId: string, kind: "supply" | "demand", key: string, change: { checked?: boolean; cannot?: boolean }, by: string): Promise<boolean> {
  const field = CHECK_FIELD[kind][key];
  if (!field) return false;
  await withPgTransaction(async (tx) => {
    await tx.query("select set_config('bulk.actor', $1, true)", [by]);
    await tx.query(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values ($1, $2, null, 'missing', 'never')
       on conflict (bulk_listing_id, field_key) do nothing`, [listingId, field]);
    if (change.checked !== undefined) {
      await tx.query("update crm_bulk_listing_fields set checked_by = $3, checked_at = $4, updated_at = now() where bulk_listing_id = $1 and field_key = $2",
        [listingId, field, change.checked ? by : null, change.checked ? new Date().toISOString() : null]);
    }
    if (change.cannot !== undefined) {
      await tx.query("update crm_bulk_listing_fields set cannot_provide = $3, updated_at = now() where bulk_listing_id = $1 and field_key = $2", [listingId, field, change.cannot]);
    }
  });
  return true;
}

/** The person's Qualified tick. Refused (with what is still open) unless every item the rule needs is done. */
export async function setQualifiedTick(listingId: string, on: boolean, by: string): Promise<{ ok: true } | { ok: false; missing: string[] }> {
  if (on) {
    const [listing] = await queryPg<{ kind: string; route: string | null; recycling: string | null }>(
      "select kind, route, context->>'recycling' as recycling from crm_bulk_listings where id = $1", [listingId]);
    if (!listing) return { ok: false, missing: ["the deal"] };
    const keys = QUALIFY_KEYS[checklistRoute(listing.route, listing.recycling)][listing.kind === "demand" ? "demand" : "supply"];
    const done = await queryPg<{ key: string; done: boolean }>("select k as key, bulk_listing_check_done($1, k) as done from unnest($2::text[]) k", [listingId, keys]);
    const missing = done.filter((d) => !d.done).map((d) => d.key);
    if (missing.length) return { ok: false, missing };
  }
  await withPgTransaction(async (tx) => {
    await tx.query("select set_config('bulk.actor', $1, true)", [by]);
    await tx.query("update crm_bulk_listings set qualified_at = $2, qualified_by = $3, updated_at = now() where id = $1",
      [listingId, on ? new Date().toISOString() : null, on ? by : null]);
  });
  return { ok: true };
}
