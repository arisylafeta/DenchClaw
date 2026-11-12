import "server-only";

// The scorecard's reads (slice 6). Every query is a SELECT inside one transaction that is read only and has
// default_transaction_read_only on, and the transaction is rolled back at the end, so nothing here can write. The rules
// are in lib/bulk-scorecard.ts; the Bulk Trades sheet comes from the same query the app uses (SHEET_QUERY).
import { pgPool, type PgTransaction } from "../postgres";
import { listingRow, sortSheet, type ListingSheetInput } from "../bulk-sheet";
import { computeScorecard, periods, type EnquiryFact, type ListingEventFact, type ListingFact, type MatchRunFact, type OfferFact, type Scorecard, type ScorecardFacts } from "../bulk-scorecard";
import { SHEET_QUERY } from "./bulk-sheet";

/** Runs `fn` in a read-only transaction and always rolls it back. Refuses to run if the database does not confirm it. */
export async function readOnly<T>(fn: (tx: PgTransaction) => Promise<T>): Promise<T> {
  const client = await pgPool.connect();
  try {
    await client.query("begin transaction read only");
    await client.query("set local default_transaction_read_only = on");
    const { rows: [mode] } = await client.query<{ ro: string; dro: string }>(
      "select current_setting('transaction_read_only') as ro, current_setting('default_transaction_read_only') as dro");
    if (mode?.ro !== "on" || mode?.dro !== "on") throw new Error("The scorecard transaction is not read-only; refusing to run.");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => `to_char(${column} at time zone 'UTC', ${ISO})`;
const MAIL_AT = "coalesce(m.sent_at, m.accepted_at, m.created_at)";

/**
 * New enquiries since `from`: one per Relay thread (relay_item, seller or buyer) whose first message is inbound from
 * outside, to an address we had sent nothing to before. With the first sent reply, the lead card and the deal it got.
 */
const ENQUIRIES = `
  with items as (
    select distinct on (i.mail_thread_id) i.id, i.mail_thread_id, i.bulk_listing_id, c.status as card_status, c.data as card_data, c.updated_at as card_at
    from relay_item i left join relay_card c on c.item_id = i.id
    where i.contact_type in ('supplier', 'buyer') and i.mail_thread_id is not null
    order by i.mail_thread_id, (c.id is null), i.created_at, i.id),
  first_msg as (
    select distinct on (it.id) it.*, m.direction, lower(m.from_email) as fe, ${MAIL_AT} as at
    from items it join mail_message m on m.thread_id = it.mail_thread_id and m.state in ('received', 'accepted')
    order by it.id, ${MAIL_AT}, m.id),
  -- When we first wrote to each address: one pass over our sent mail.
  written as (
    select lower(regexp_replace(a, '^.*<|>.*$', '', 'g')) as addr, min(coalesce(p.sent_at, p.accepted_at)) as first_at
    from mail_message p, unnest(p.to_emails || p.cc_emails) a
    where p.direction = 'outbound' and p.state = 'accepted' group by 1)
  select f.id, ${iso("f.at")} as arrived_at,
    (select ${iso("min(coalesce(o.sent_at, o.accepted_at))")} from mail_message o where o.thread_id = f.mail_thread_id and o.direction = 'outbound'
       and o.state = 'accepted' and coalesce(o.purpose, '') <> 'marketing' and o.campaign_id is null and coalesce(o.sent_at, o.accepted_at) > f.at) as replied_at,
    f.card_status, f.card_data->'lead'->'route'->>'route' as route,
    case when jsonb_typeof(f.card_data->'sent') = 'object' then f.card_data->'sent' end as sent,
    case when f.card_status = 'dismissed' then ${iso("f.card_at")} end as dismissed_at,
    b.id as deal_id, ${iso("b.created_at")} as deal_created_at,
    -- a card prepared before routes existed is a bulk lead (relay-lead-core suggestedRoute)
    (f.card_status is not null and f.card_data ? 'lead' and not (f.card_data->'lead' ? 'route')) as old_card
  from first_msg f
  left join crm_bulk_listings b on b.id = coalesce(f.card_data->'sent'->>'deal_id', f.bulk_listing_id)
  where f.direction = 'inbound' and f.fe like '%@%' and f.fe not like '%rebattery.io' and f.at >= $1::timestamptz
    and not exists (select 1 from written w where w.addr = f.fe and w.first_at < f.at)`;

const LISTINGS = `select id, kind, source_kind, ${iso("created_at")} as created_at from crm_bulk_listings where created_at >= $1::timestamptz`;

const EVENTS = `
  select e.subject_id as listing_id, e.to_stage, ${iso("e.occurred_at")} as at, coalesce(e.note, '') = 'As of migration 111' as starting,
    ${iso("l.created_at")} as created_at
  from crm_bulk_stage_events e join crm_bulk_listings l on l.id = e.subject_id
  where e.subject_kind = 'listing' and coalesce(l.source_kind, '') <> 'research'
  order by e.occurred_at, e.id`;

/** Each deal's first match run that found candidates (runMatches logs one activity row per run), and every verdict on it. */
const RUNS = `
  select r.deal_id, ${iso("r.at")} as at, r.count,
    coalesce((select array_agg(${iso("m.verdict_at")}) from crm_bulk_matches m where m.deal_id = r.deal_id and m.verdict is not null), '{}') as verdicts
  from (select distinct on (a.bulk_listing_id) a.bulk_listing_id as deal_id, a.occurred_at as at, (a.data->'match_run'->>'count')::int as count
        from crm_bulk_listing_activity a join crm_bulk_listings l on l.id = a.bulk_listing_id
        where jsonb_typeof(a.data->'match_run') = 'object' and coalesce(a.data->'match_run'->>'count', '') ~ '^[0-9]+$'
          and (a.data->'match_run'->>'count')::int > 0 and coalesce(l.source_kind, '') <> 'research'
        order by a.bulk_listing_id, a.occurred_at, a.id) r`;

const OFFERS = `
  select o.id, case when l.kind = 'supply' then 'buyer' else 'seller' end as side, o.stage,
    case when o.terms->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$' then (o.terms->>'amount')::float8 end as amount,
    o.quantity::float8 as quantity, o.paid_on::text as paid_on, o.paid_amount::float8 as paid_amount, o.paid_currency, o.take_gbp::float8 as take_gbp,
    ${iso("o.created_at")} as created_at, o.last_touch_on::text as last_touch_on,
    coalesce((select jsonb_agg(jsonb_build_object('to', e.to_stage, 'at', ${iso("e.occurred_at")}, 'starting', coalesce(e.note, '') = 'As of migration 111') order by e.occurred_at, e.id)
      from crm_bulk_stage_events e where e.subject_kind = 'offer' and e.subject_id = o.id), '[]'::jsonb) as events,
    coalesce((select array_agg(${iso(MAIL_AT)}) from crm_bulk_thread_links t join mail_message m on m.thread_id = t.thread_id
      where t.offer_id = o.id and t.channel = 'mail' and t.state <> 'rejected' and m.state in ('received', 'accepted')), '{}') as mail_at,
    case when l.kind = 'supply' then jsonb_build_object('value', f.value, 'status', f.status, 'validUntil', bulk_listing_quote_until(l.id)::text) end as quote,
    case when m.id is not null then jsonb_build_object('created_at', ${iso("m.created_at")}, 'verdict', m.verdict, 'quote_valid_until', m.quote_valid_until::text) end as match,
    exists (select 1 from crm_bulk_listing_activity a join crm_bulk_listing_documents d on d.id = a.data->>'document_id'
      where a.offer_id = o.id and a.kind = 'document' and d.doc_type = 'Quote' and d.state = 'sent') as sheet_sent,
    exists (select 1 from relay_card c where c.data->'sent'->>'opened' = 'true'
      and c.data->'sent'->>'deal_id' in (o.bulk_listing_id, coalesce(o.counterpart_id, ''))) as from_card
  from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id
  left join crm_bulk_listing_fields f on f.bulk_listing_id = l.id and f.field_key = 'seller_price'
  left join crm_bulk_matches m on m.offer_id = o.id
  where o.role = 'counterparty' and coalesce(l.source_kind, '') <> 'research'`;

type EnquiryRow = EnquiryFact & { old_card: boolean };

/** Every fact the eleven measures need, read in one read-only transaction. */
export async function scorecardFacts(tx: PgTransaction, since: string): Promise<ScorecardFacts> {
  const enquiries = (await tx.query<EnquiryRow>(ENQUIRIES, [since])).rows.map(({ old_card, ...e }) => ({ ...e, route: e.route ?? (old_card ? "bulk" : null) }));
  const listings = (await tx.query<ListingFact>(LISTINGS, [since])).rows;
  const research = new Set((await tx.query<{ id: string }>("select id from crm_bulk_listings where source_kind = 'research'")).rows.map((r) => r.id));
  const sheet = sortSheet((await tx.query<ListingSheetInput>(SHEET_QUERY)).rows.map(listingRow)).filter((row) => !research.has(row.id));
  const events = (await tx.query<ListingEventFact>(EVENTS)).rows;
  const runs = (await tx.query<MatchRunFact>(RUNS)).rows;
  const offers = (await tx.query<OfferFact>(OFFERS)).rows;
  return { enquiries, listings, sheet, events, runs, offers };
}

/** The scorecard for the week holding `week` (default: the last full week) and the quarter to date. Read only. */
export async function loadScorecard(now: Date = new Date(), week?: string | null): Promise<Scorecard> {
  const p = periods(now, week);
  const since = [p.previous.from, p.quarter.from].sort()[0];
  return readOnly(async (tx) => computeScorecard(await scorecardFacts(tx, since), now, week));
}

export type Housekeeping = {
  /** Reservations past their last day still marked offered: bulk_matches_expire() has not run since. */
  lapsed: { count: number; oldest: string | null };
  /** Open listings whose stage now differs from the last one logged: bulk_stage_check_all() has not run since. */
  behind: { count: number; holdsEnded: number; ids: string[]; examples: { id: string; title: string; logged: string | null; now: string | null }[] };
};

/** What the two daily functions would change if they ran now, worked out with SELECTs only. */
export async function housekeeping(): Promise<Housekeeping> {
  return readOnly(async (tx) => {
    const { rows: [lapsed] } = await tx.query<{ count: number; oldest: string | null }>(
      `select count(*)::int as count, min(reserved_until)::text as oldest from crm_bulk_matches
       where state = 'offered' and reserved_until is not null and reserved_until < current_date`);
    const { rows } = await tx.query<{ id: string; title: string; logged: string | null; now: string | null; hold_ended: boolean }>(
      `select l.id, coalesce(nullif(l.spec->>'listing_title', ''), l.summary) as title, e.to_stage as logged, s.stage as now,
         (l.hold_until is not null and l.hold_until < current_date and e.to_stage = 'Reserved') as hold_ended
       from crm_bulk_listings l
       cross join lateral (select bulk_listing_stage(l.id) as stage) s
       left join lateral (select x.to_stage from crm_bulk_stage_events x where x.subject_kind = 'listing' and x.subject_id = l.id
         order by x.occurred_at desc, x.id desc limit 1) e on true
       where l.status <> 'closed' and s.stage is distinct from e.to_stage
       order by l.id`);
    return {
      lapsed,
      behind: { count: rows.length, holdsEnded: rows.filter((r) => r.hold_ended).length, ids: rows.map((r) => r.id), examples: rows.slice(0, 5).map(({ hold_ended: _, ...r }) => r) },
    };
  });
}
