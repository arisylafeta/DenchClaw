-- REB-203: immutable trade evidence plus a read-only bulk-trade projection.

create table if not exists crm_trade_evidence_sources (
  id text primary key,
  source_kind text not null check (source_kind in ('whatsapp_export', 'gmail', 'crm', 'marketplace_snapshot')),
  source_path text not null,
  source_sha256 text not null,
  imported_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists crm_trade_evidence_messages (
  id text primary key,
  source_id text not null references crm_trade_evidence_sources(id),
  source_member text not null,
  conversation text not null,
  message_index integer not null check (message_index >= 0),
  occurred_at timestamptz not null,
  sender text not null,
  body text not null,
  content_sha256 text not null,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  occurrences jsonb not null default '[]'::jsonb,
  unique (source_id, source_member, message_index)
);
create index if not exists crm_trade_evidence_messages_conversation_at_idx
  on crm_trade_evidence_messages (conversation, occurred_at);
create index if not exists crm_trade_evidence_messages_content_sha_idx
  on crm_trade_evidence_messages (content_sha256);

create table if not exists crm_trade_evidence_attachments (
  id text primary key,
  source_id text not null references crm_trade_evidence_sources(id),
  source_member text not null,
  conversation text not null,
  archive_member text not null,
  filename text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  content_sha256 text not null,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  occurrences jsonb not null default '[]'::jsonb,
  unique (source_id, source_member, archive_member)
);
create index if not exists crm_trade_evidence_attachments_content_sha_idx
  on crm_trade_evidence_attachments (content_sha256);

create or replace function reject_trade_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'trade evidence is immutable; import a new source instead';
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'crm_trade_evidence_sources',
    'crm_trade_evidence_messages',
    'crm_trade_evidence_attachments'
  ] loop
    if not exists (
      select 1 from pg_trigger
      where tgname = table_name || '_immutable'
        and tgrelid = table_name::regclass
        and not tgisinternal
    ) then
      execute format(
        'create trigger %I before update or delete on %I for each row execute function reject_trade_evidence_mutation()',
        table_name || '_immutable', table_name
      );
    end if;
  end loop;
end;
$$;

create table if not exists crm_bulk_trade_lots (
  id text primary key,
  title text not null,
  lot_kind text not null check (lot_kind in ('supply', 'demand')),
  summary text not null,
  stage text not null default 'Sourced'
    check (stage in ('Sourced', 'In Campaign', 'In Conversation', 'In Payment', 'In Collection', 'Completed')),
  people_sent_count integer not null default 0 check (people_sent_count >= 0),
  observed_quantity numeric,
  quantity_unit text,
  observed_outcome text not null,
  latest_activity_at timestamptz,
  needs_attention boolean not null default false,
  confidence text not null check (confidence in ('confirmed', 'probable', 'uncertain')),
  reconciliation_note text,
  source_manifest jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table crm_bulk_trade_lots
  add column if not exists stage text not null default 'Sourced',
  add column if not exists people_sent_count integer not null default 0;
do $$
begin
  alter table crm_bulk_trade_lots drop constraint if exists crm_bulk_trade_lots_stage_check;
  alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_stage_check
    check (stage in ('Sourced', 'In Campaign', 'In Conversation', 'In Payment', 'In Collection', 'Completed'));
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'crm_bulk_trade_lots'::regclass
      and conname = 'crm_bulk_trade_lots_people_sent_count_check'
  ) then
    alter table crm_bulk_trade_lots add constraint crm_bulk_trade_lots_people_sent_count_check
      check (people_sent_count >= 0);
  end if;
end;
$$;

create table if not exists crm_bulk_trade_parties (
  id text primary key,
  lot_id text not null references crm_bulk_trade_lots(id) on delete cascade,
  role text not null check (role in ('supplier', 'buyer', 'intermediary', 'advisor')),
  display_name text not null,
  company_id text references crm_companies(id) on delete set null,
  channel text,
  observed_outcome text,
  first_evidence_at timestamptz,
  latest_evidence_at timestamptz,
  notes text
);
create index if not exists crm_bulk_trade_parties_lot_idx on crm_bulk_trade_parties (lot_id);

create table if not exists crm_bulk_trade_evidence_links (
  lot_id text not null references crm_bulk_trade_lots(id) on delete cascade,
  evidence_kind text not null check (
    evidence_kind in ('whatsapp_message', 'whatsapp_attachment', 'gmail_thread', 'gmail_message',
                      'crm_opportunity', 'marketplace_listing', 'marketplace_offer', 'marketplace_deal')
  ),
  evidence_id text not null,
  relationship text not null default 'supports',
  note text,
  primary key (lot_id, evidence_kind, evidence_id)
);

drop view if exists crm_bulk_trade_overview;
create view crm_bulk_trade_overview as
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
  lot.reconciliation_note
from crm_bulk_trade_lots lot
left join party_summary party on party.lot_id = lot.id
left join evidence_summary evidence on evidence.lot_id = lot.id;

insert into crm_objects
  (id, name, entity_table, description, default_view, display_field, immutable, hidden_in_sidebar, sort_order)
values
  ('reb_bulk_trade_object', 'bulk_trade', 'crm_bulk_trade_overview',
   'Read-only evidence view of bulk supply, demand, buyer interactions, and authoritative marketplace links',
   'kanban', 'reb_bulk_trade_title', true, false, 2)
on conflict (name) do update set
  entity_table = excluded.entity_table,
  description = excluded.description,
  default_view = excluded.default_view,
  display_field = excluded.display_field,
  immutable = excluded.immutable,
  hidden_in_sidebar = excluded.hidden_in_sidebar,
  sort_order = excluded.sort_order,
  updated_at = now();

update crm_objects set sort_order = 3, updated_at = now() where name = 'work_task';

insert into crm_fields
  (id, object_id, name, type, canonical_column, required, sort_order)
values
  ('reb_bulk_trade_title', 'reb_bulk_trade_object', 'Title', 'text', 'title', true, 0),
  ('reb_bulk_trade_stage', 'reb_bulk_trade_object', 'Stage', 'enum', 'stage', true, 1),
  ('reb_bulk_trade_kind', 'reb_bulk_trade_object', 'Type', 'enum', 'lot_kind', true, 2),
  ('reb_bulk_trade_sent_to', 'reb_bulk_trade_object', 'Sent To', 'number', 'people_sent_count', true, 3),
  ('reb_bulk_trade_summary', 'reb_bulk_trade_object', 'Summary', 'richtext', 'summary', true, 4),
  ('reb_bulk_trade_quantity', 'reb_bulk_trade_object', 'Observed Quantity', 'number', 'observed_quantity', false, 5),
  ('reb_bulk_trade_unit', 'reb_bulk_trade_object', 'Quantity Unit', 'text', 'quantity_unit', false, 6),
  ('reb_bulk_trade_outcome', 'reb_bulk_trade_object', 'Observed Outcome', 'text', 'observed_outcome', true, 7),
  ('reb_bulk_trade_buyers', 'reb_bulk_trade_object', 'Buyer Interactions', 'number', 'buyer_interactions', true, 8),
  ('reb_bulk_trade_latest', 'reb_bulk_trade_object', 'Latest Evidence At', 'date', 'latest_evidence_at', false, 9),
  ('reb_bulk_trade_attention', 'reb_bulk_trade_object', 'Needs Attention', 'boolean', 'needs_attention', true, 10),
  ('reb_bulk_trade_confidence', 'reb_bulk_trade_object', 'Confidence', 'enum', 'confidence', true, 11),
  ('reb_bulk_trade_evidence_count', 'reb_bulk_trade_object', 'Evidence Count', 'number', 'evidence_count', true, 12),
  ('reb_bulk_trade_sources', 'reb_bulk_trade_object', 'Source Systems', 'text', 'source_systems', false, 13),
  ('reb_bulk_trade_marketplace', 'reb_bulk_trade_object', 'Marketplace Links', 'number', 'marketplace_links', true, 14),
  ('reb_bulk_trade_reconciliation', 'reb_bulk_trade_object', 'Reconciliation Note', 'richtext', 'reconciliation_note', false, 15)
on conflict (object_id, name) do update set
  type = excluded.type,
  canonical_column = excluded.canonical_column,
  required = excluded.required,
  sort_order = excluded.sort_order;

update crm_fields set
  enum_values = '["Sourced", "In Campaign", "In Conversation", "In Payment", "In Collection", "Completed"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Stage';
update crm_fields set
  enum_values = '["supply", "demand"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Type';
update crm_fields set
  enum_values = '["confirmed", "probable", "uncertain"]'::jsonb
where object_id = 'reb_bulk_trade_object' and name = 'Confidence';
