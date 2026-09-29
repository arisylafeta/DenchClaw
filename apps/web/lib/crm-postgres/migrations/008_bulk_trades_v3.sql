-- Bulk Trades v3, PR 1: hand-maintained next steps, stages and shipping dates.
-- Adds columns and a change log. Existing columns, rows and the old Stage stay as they are.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_bulk_trade_lots
  add column if not exists trade_stage text not null default 'Needs info',
  add column if not exists trade_kind text,
  add column if not exists fact_line text,
  add column if not exists next_step text,
  add column if not exists next_step_due date,
  add column if not exists waiting_on text not null default 'us',
  add column if not exists waiting_since date,
  add column if not exists owner_user_id uuid references crm_users(id) on delete set null,
  add column if not exists value text,
  add column if not exists last_touched date,
  add column if not exists clear_by date,
  add column if not exists ship_by date,
  add column if not exists transport_class text,
  add column if not exists tfs_needed text not null default 'unknown';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_lots_trade_stage_check') then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_trade_stage_check
      check (trade_stage in ('Needs info', 'With buyers', 'Closing', 'Done', 'Lost'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_lots_trade_kind_check') then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_trade_kind_check
      check (trade_kind in ('packs', 'cells', 'systems', 'recycling'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_lots_waiting_on_check') then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_waiting_on_check
      check (waiting_on in ('us', 'them'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'crm_bulk_trade_lots_tfs_needed_check') then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_tfs_needed_check
      check (tfs_needed in ('yes', 'no', 'unknown'));
  end if;
end;
$$;

-- Append-only log of hand edits. Buyer status and bid events join it in PR 2.
create table if not exists crm_bulk_trade_events (
  id bigserial primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete restrict,
  kind text not null check (kind in ('trade_created', 'trade_updated')),
  changes jsonb not null default '{}'::jsonb,
  actor_user_id uuid references crm_users(id) on delete set null,
  occurred_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_events_lot_at_idx
  on crm_bulk_trade_events (lot_id, occurred_at);

create or replace function reject_bulk_trade_event_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'bulk trade events are append-only';
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'crm_bulk_trade_events_append_only'
      and tgrelid = 'crm_bulk_trade_events'::regclass
  ) then
    create trigger crm_bulk_trade_events_append_only
      before update or delete on crm_bulk_trade_events
      for each row execute function reject_bulk_trade_event_mutation();
  end if;
end;
$$;

-- Approved mapping. Completed goes to Done; Alex relabels any Lost trades by hand at go-live.
-- Only rows still on the column default are mapped, so a re-run never undoes a manual stage.
update crm_bulk_trade_lots set trade_stage = case stage
    when 'Sourced' then 'Needs info'
    when 'In Campaign' then 'With buyers'
    when 'In Conversation' then 'With buyers'
    when 'In Payment' then 'Closing'
    when 'In Collection' then 'Closing'
    when 'Shortlisted' then 'With buyers'
    when 'Quoting' then 'With buyers'
    when 'Signing agreement' then 'Closing'
    when 'Payment and collection' then 'Closing'
    when 'Completed' then 'Done'
  end
where trade_stage = 'Needs info' and stage <> 'Sourced'
  and not exists (select 1 from crm_bulk_trade_events event where event.lot_id = crm_bulk_trade_lots.id);

-- Same projection as 003, with the new columns appended so existing readers keep working.
create or replace view crm_bulk_trade_overview as
with party_summary as (
  select
    lot_id,
    count(*) filter (where role = 'buyer')::integer as buyer_interactions,
    max(latest_evidence_at) as latest_party_at
  from crm_bulk_trade_parties
  group by lot_id
),
evidence_summary as (
  select
    link.lot_id,
    count(*)::integer as evidence_count,
    string_agg(distinct link.evidence_kind, ', ' order by link.evidence_kind) as source_systems,
    count(*) filter (where link.evidence_kind like 'marketplace_%')::integer as marketplace_links,
    max(message.occurred_at) as latest_message_at
  from crm_bulk_trade_evidence_links link
  left join crm_trade_evidence_messages message
    on link.evidence_kind = 'whatsapp_message'
   and message.id = link.evidence_id
  group by link.lot_id
)
select
  lot.id,
  lot.created_at,
  lot.updated_at,
  lot.title,
  lot.lot_kind,
  lot.summary,
  lot.stage,
  lot.people_sent_count,
  lot.observed_quantity,
  lot.quantity_unit,
  lot.observed_outcome,
  coalesce(party.buyer_interactions, 0) as buyer_interactions,
  greatest(lot.latest_activity_at, party.latest_party_at, evidence.latest_message_at) as latest_evidence_at,
  lot.needs_attention,
  lot.confidence,
  coalesce(evidence.evidence_count, 0) as evidence_count,
  coalesce(evidence.source_systems, '') as source_systems,
  coalesce(evidence.marketplace_links, 0) as marketplace_links,
  lot.reconciliation_note,
  lot.trade_stage,
  lot.trade_kind,
  lot.fact_line,
  lot.next_step,
  lot.next_step_due,
  lot.waiting_on,
  lot.waiting_since,
  lot.owner_user_id,
  lot.value,
  lot.last_touched,
  lot.clear_by,
  lot.ship_by,
  lot.transport_class,
  lot.tfs_needed
from crm_bulk_trade_lots lot
left join party_summary party on party.lot_id = lot.id
left join evidence_summary evidence on evidence.lot_id = lot.id;

insert into crm_fields
  (id, object_id, name, type, canonical_column, required, sort_order)
values
  ('reb_bulk_trade_trade_stage', 'reb_bulk_trade_object', 'Trade Stage', 'enum', 'trade_stage', true, 16),
  ('reb_bulk_trade_trade_kind', 'reb_bulk_trade_object', 'Trade Kind', 'enum', 'trade_kind', false, 17),
  ('reb_bulk_trade_fact_line', 'reb_bulk_trade_object', 'Fact Line', 'text', 'fact_line', false, 18),
  ('reb_bulk_trade_next_step', 'reb_bulk_trade_object', 'Next Step', 'text', 'next_step', false, 19),
  ('reb_bulk_trade_next_step_due', 'reb_bulk_trade_object', 'Next Step Due', 'date', 'next_step_due', false, 20),
  ('reb_bulk_trade_waiting_on', 'reb_bulk_trade_object', 'Waiting On', 'enum', 'waiting_on', true, 21),
  ('reb_bulk_trade_waiting_since', 'reb_bulk_trade_object', 'Waiting Since', 'date', 'waiting_since', false, 22),
  ('reb_bulk_trade_value', 'reb_bulk_trade_object', 'Value', 'text', 'value', false, 23),
  ('reb_bulk_trade_last_touched', 'reb_bulk_trade_object', 'Last Touched', 'date', 'last_touched', false, 24),
  ('reb_bulk_trade_clear_by', 'reb_bulk_trade_object', 'Clear By', 'date', 'clear_by', false, 25),
  ('reb_bulk_trade_ship_by', 'reb_bulk_trade_object', 'Ship By', 'date', 'ship_by', false, 26),
  ('reb_bulk_trade_transport_class', 'reb_bulk_trade_object', 'Transport Class', 'text', 'transport_class', false, 27),
  ('reb_bulk_trade_tfs_needed', 'reb_bulk_trade_object', 'TFS Needed', 'enum', 'tfs_needed', true, 28)
on conflict (object_id, name) do update set
  type = excluded.type,
  canonical_column = excluded.canonical_column,
  required = excluded.required,
  sort_order = excluded.sort_order;

update crm_fields set enum_values = '["Needs info", "With buyers", "Closing", "Done", "Lost"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Trade Stage';
update crm_fields set enum_values = '["packs", "cells", "systems", "recycling"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Trade Kind';
update crm_fields set enum_values = '["us", "them"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Waiting On';
update crm_fields set enum_values = '["yes", "no", "unknown"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'TFS Needed';

commit;
