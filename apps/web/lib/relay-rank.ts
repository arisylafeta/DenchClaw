import "server-only";
import { queryPg } from "./postgres";
import { mailboxScopeSql } from "./mail-scope";
import { listRelayItems, relayCounts, type RelayCounts, type RelayItem } from "./relay";
import { isPersonalDomain } from "./relay-identity";
import { personKeys } from "./relay-people";
import { rankItems, type RankBand, type RankItem, type WaitingRow } from "./relay-rank-core";

export type { RankBand, WaitingRow } from "./relay-rank-core";

/** The list by band, best first in each, and the numbers on the view tabs. */
export type WaitingView = {
  bands: Record<RankBand, WaitingRow[]>;
  /** People whose reply Alex scheduled with Send later, soonest first. Not waiting on him: not in the bands or the count. */
  scheduled: WaitingRow[];
  counts: { waiting: number; chase: number; drafts: number; done_today: number };
};

/** Deals that traded: they bought from us, or sold to us. */
const TRADED = "('bought_from_us','sold','became_trade')";
const AT = "coalesce(m.sent_at, m.accepted_at, m.created_at)";

type ItemFacts = { id: string; waiting_inbound: string[]; deal_status: string | null; deal_held: boolean; deal_value: string | null; deal_quantity: string | null; has_draft: boolean };
type SenderFacts = {
  email: string; person_id: string | null; merged_into: string[]; company_id: string | null; customer: boolean;
  past_deals: number; inbound: number; first_inbound: string | null;
};

/** Per email: their messages since Alex last wrote on the thread, the linked deal, and an unsent draft. */
const itemFacts = (ownerId: string, ids: string[]) => queryPg<ItemFacts>(
  `select i.id,
     coalesce((select array_agg(${AT}::text order by ${AT}) from mail_message m
        where m.thread_id = i.mail_thread_id and m.direction = 'inbound' and m.state = 'received'
          and ${AT} > coalesce((select max(coalesce(o.sent_at, o.accepted_at, o.created_at)) from mail_message o
            where o.thread_id = i.mail_thread_id and o.direction = 'outbound' and o.state = 'accepted'), '-infinity'::timestamptz)), '{}') as waiting_inbound,
     b.status as deal_status, coalesce(b.hold_until >= current_date, false) as deal_held, b.value as deal_value, b.quantity as deal_quantity,
     exists (select 1 from relay_draft d where d.item_id = i.id and d.state in ('draft','gmail')) as has_draft
   from relay_item i left join crm_bulk_listings b on b.id = i.bulk_listing_id
   where i.owner_id = $1::uuid and i.id = any($2)`, [ownerId, ids]);

/** Per sender: their CRM person and company, past trades, and how long and how often they have written. Company
 * domains (never personal ones) find the company when the CRM has no person for the address. */
const senderFacts = (ownerId: string, emails: string[], domains: string[]) => queryPg<SenderFacts>(
  `with x as (select e as email, split_part(e, '@', 2) as domain from unnest($1::text[]) e),
   p as (
     select x.email, x.domain, person.id as person_id,
       coalesce(person.company_id, case when x.domain = any($2) then
         (select case when count(*) = 1 then min(c.id) end from crm_companies c where lower(c.domain) in (x.domain, 'www.' || x.domain)) end) as company_id
     from x left join lateral (select id, company_id from crm_people where lower(email) = x.email
       order by (company_id is not null) desc, updated_at desc limit 1) person on true)
   select p.email, p.person_id, p.company_id,
     coalesce((select array_agg(distinct l.keeper_id) from crm_merge_log l where l.entity = 'person' and lower(l.loser_row->>'email') = p.email), '{}') as merged_into,
     coalesce((select c.buyer_stage = 'Customer' from crm_companies c where c.id = p.company_id), false) as customer,
     (select count(*) from crm_bulk_listings b left join crm_people bp on bp.id = b.person_id
       where b.closed_reason in ${TRADED} and (lower(coalesce(b.email, bp.email)) = p.email or b.company_id = p.company_id
         or (p.person_id is not null and b.person_id = p.person_id)))::int as past_deals,
     (select count(*) from mail_message m where lower(m.from_email) = p.email and m.direction = 'inbound' and ${mailboxScopeSql("m", "$3")})::int as inbound,
     (select min(${AT})::text from mail_message m where lower(m.from_email) = p.email and m.direction = 'inbound' and ${mailboxScopeSql("m", "$3")}) as first_inbound
   from p`, [emails, domains, ownerId]);

/** Addresses and company domains anyone at ReBattery has written to by hand (campaigns aside), as relay_scan.py's
 * load_written_to counts a first contact. */
const writtenTo = (emails: string[], domains: string[]) => queryPg<{ address: string }>(
  `select distinct lower(a) as address from mail_message m, unnest(coalesce(m.to_emails,'{}') || coalesce(m.cc_emails,'{}')) a
   where m.direction = 'outbound' and m.state in ('accepted','received') and m.campaign_id is null and coalesce(m.purpose, '') <> 'marketing'
     and (lower(a) = any($1) or split_part(lower(a), '@', 2) = any($2))`, [emails, domains]);

/** The fields of a Relay email the ranking reads. */
export type RankSource = Pick<RelayItem, "id" | "status" | "tab" | "priority" | "counterpart_name" | "counterpart_email" | "company" | "contact_type"
  | "situation" | "headline" | "waiting_since" | "overdue_since" | "last_message"> & { scheduled_at?: string | null };

/** The owner's emails in Review with a draft not yet sent: they join their person's row as "Draft ready". */
export const reviewWithDrafts = (ownerId: string) => queryPg<RankSource>(
  `select i.id, i.status, i.tab, i.priority, i.counterpart_name, i.counterpart_email, i.company, i.contact_type, i.situation, i.headline,
     i.waiting_since, i.overdue_since, i.last_message,
     -- The reply Alex scheduled with Send later (not the 30-second hold of Send): the person moves to "Scheduled".
     (select m.personalization->'scheduled_send'->>'at' from relay_draft d join mail_message m on m.id = d.mail_message_id
       where d.item_id = i.id and d.role = 'primary' and d.state in ('draft','gmail') and m.state = 'draft' and m.personalization ? 'scheduled_send'
         and not coalesce((m.personalization->'scheduled_send'->>'undo')::boolean, false) order by 1 limit 1) as scheduled_at
   from relay_item i where i.owner_id = $1::uuid and i.status = 'review' and i.tab = 'action' and (i.snooze_until is null or i.snooze_until <= now())
     and exists (select 1 from relay_draft d where d.item_id = i.id and d.state in ('draft','gmail'))`, [ownerId]);

const LIVE = new Set(["open", "qualifying"]);
/** pg hands timestamps back as Dates, jsonb ones as text: the ranking reads ISO text. */
const iso = (v: unknown): string | null => {
  const t = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const emailOf = (i: RankSource) => (i.counterpart_email ?? "").toLowerCase().trim();

/** Builds what the ranking reads for each open email. */
export async function rankInputs(ownerId: string, items: RankSource[]): Promise<RankItem[]> {
  if (!items.length) return [];
  const emails = [...new Set(items.map(emailOf).filter(Boolean))];
  const domains = [...new Set(emails.map((e) => e.split("@")[1] ?? "").filter((d) => d && !isPersonalDomain(d) && d !== "rebattery.io"))];
  const [facts, senders, written, people] = await Promise.all([
    itemFacts(ownerId, items.map((i) => i.id)), senderFacts(ownerId, emails, domains), writtenTo(emails, domains), personKeys(ownerId, emails),
  ]);
  const factOf = new Map(facts.map((f) => [f.id, f]));
  const senderOf = new Map(senders.map((s) => [s.email, s]));
  const wroteTo = new Set(written.map((w) => w.address));
  const wroteDomain = new Set(written.map((w) => w.address.split("@")[1]).filter((d) => domains.includes(d)));
  return items.map((i) => {
    const email = emailOf(i);
    const domain = email.split("@")[1] ?? "";
    const f = factOf.get(i.id);
    const s = senderOf.get(email);
    return {
      id: i.id, status: i.status === "review" ? "review" : "open", email: email || null, name: i.counterpart_name, company: i.company, contactType: i.contact_type, situation: i.situation,
      tab: i.tab, priority: i.priority, headline: i.headline, waitingSince: iso(i.waiting_since), overdueSince: iso(i.overdue_since), lastAt: iso(i.last_message?.at) ?? iso(i.waiting_since),
      text: i.last_message?.direction === "inbound" ? i.last_message.text : "",
      personIds: [s?.person_id, ...(s?.merged_into ?? [])].filter((p): p is string => !!p),
      personKey: people.get(email) ?? null,
      companyId: s?.company_id ?? null,
      personal: !domain || isPersonalDomain(domain),
      deal: f?.deal_status ? { live: LIVE.has(f.deal_status) && !f.deal_held, value: f.deal_value, quantity: f.deal_quantity } : null,
      waitingInbound: (f?.waiting_inbound ?? []).map(iso).filter((t): t is string => !!t),
      firstContact: !!email && !wroteTo.has(email) && !wroteDomain.has(domain),
      pastDeals: s?.past_deals ?? 0,
      customer: s?.customer ?? false,
      inboundEmails: s?.inbound ?? 0,
      firstInboundAt: iso(s?.first_inbound),
      hasDraft: f?.has_draft ?? false,
      scheduledAt: iso(i.scheduled_at),
    };
  });
}

/** The ranked rows by band, with the view counts (relayCounts) beside them. */
export function waitingView(rows: WaitingRow[], counts: Pick<RelayCounts, "follow" | "review" | "done_today">): WaitingView {
  const bands: WaitingView["bands"] = { now: [], today: [], week: [], later: [] };
  const scheduled = rows.filter((r) => r.scheduledAt).sort((a, b) => Date.parse(a.scheduledAt!) - Date.parse(b.scheduledAt!));
  const waiting = rows.filter((r) => !r.scheduledAt);
  for (const row of waiting) bands[row.band].push(row);
  return { bands, scheduled, counts: { waiting: waiting.length, chase: counts.follow, drafts: counts.review, done_today: counts.done_today } };
}

/** "Waiting on you": the open emails that need a reply, one row per person, ranked at read time, by band. Snoozed
 * emails stay hidden (listRelayItems). Chase due is Relay's follow-ups, Drafts the emails in Review. */
export async function listWaiting(ownerId: string, now = new Date()): Promise<WaitingView> {
  const [items, review, counts] = await Promise.all([listRelayItems(ownerId, "action"), reviewWithDrafts(ownerId), relayCounts(ownerId)]);
  return waitingView(rankItems(await rankInputs(ownerId, [...items, ...review]), now), counts);
}
