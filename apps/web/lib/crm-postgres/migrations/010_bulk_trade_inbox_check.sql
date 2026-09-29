-- Bulk Trades v3, Phase 2: the inbox check. Runs read Alex's synced Gmail and Granola notes,
-- match them to trades, and store proposals. Nothing is changed until Alex accepts a proposal.
-- Adds tables only. Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_bulk_trade_check_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  emails_read integer not null default 0,
  notes_read integer not null default 0,
  proposals_made integer not null default 0,
  error text,
  -- Where the next run starts: {"gmail_since": ..., "granola_since": ...}
  cursor jsonb not null default '{}'::jsonb
);
create index if not exists crm_bulk_trade_check_runs_started_idx on crm_bulk_trade_check_runs (started_at desc);

-- One proposed change, always with the quote and source it came from. lot_id is null for a
-- possible new trade. kind decides what `target` and `proposed` hold:
--   field          target = template field key, proposed = {value, status}
--   buyer_update   target = buyer id, proposed = {status?, last_touch_on?, last_touch_via?, chase_on?}
--   next_step      proposed = {next_step, next_step_due?, waiting_on?}
--   new_buyer      proposed = {name, contact?, wants?}
--   file           proposed = {file_name, gmail_message_id, attachment_id?, file_type}
--   needs_triage   proposed = {lot_ids} (one thread touches several trades)
--   possible_trade proposed = {title, trade_kind?}
create table if not exists crm_bulk_trade_proposals (
  id bigserial primary key,
  lot_id text references crm_bulk_trade_lots(id) on delete restrict,
  run_id bigint references crm_bulk_trade_check_runs(id) on delete set null,
  kind text not null check (kind in (
    'field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'possible_trade'
  )),
  target text,
  proposed jsonb not null,
  summary text not null,
  quote text not null check (length(trim(quote)) > 0),
  source_kind text not null check (source_kind in ('gmail', 'granola')),
  source_id text not null,
  source_thread text,
  source_url text,
  source_label text not null,
  source_at timestamptz,
  status text not null default 'new' check (status in ('new', 'accepted', 'ignored')),
  decided_at timestamptz,
  decided_by uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);
-- A re-run over the same source never proposes the same change twice.
create unique index if not exists crm_bulk_trade_proposals_dedupe_idx on crm_bulk_trade_proposals
  (coalesce(lot_id, ''), kind, coalesce(target, ''), source_id, md5(proposed::text));
create index if not exists crm_bulk_trade_proposals_open_idx on crm_bulk_trade_proposals (lot_id) where status = 'new';

alter table crm_bulk_trade_events drop constraint if exists crm_bulk_trade_events_kind_check;
alter table crm_bulk_trade_events add constraint crm_bulk_trade_events_kind_check check (kind in (
  'trade_created', 'trade_updated',
  'buyer_added', 'buyer_updated', 'bid_added',
  'contact_added', 'contact_updated', 'contact_removed',
  'field_updated', 'file_added', 'file_updated',
  'email_drafted', 'link_clicked',
  'proposal_accepted', 'proposal_ignored'
));

commit;
