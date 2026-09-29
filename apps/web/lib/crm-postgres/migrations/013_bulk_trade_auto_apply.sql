-- Bulk Trades: the inbox check applies what it finds instead of asking. Each email thread or call
-- is first placed on one trade (or none); only threads placed on a trade are read for data. Found
-- changes are written straight to the trade and kept as "applied" proposals with what they
-- replaced, so each one can be undone. Buyer status changes, possible new trades and threads that
-- touch several trades still wait for Alex. Inbox-check writes are logged with no actor.
-- Adds a table and columns, and widens checks only. Apply only after a current backup and
-- explicit schema approval.
begin;

-- Which trade an email thread or call belongs to. lot_id null with verdict 'none' means it is not
-- about any live trade (for example an older, finished deal with the same people).
create table if not exists crm_bulk_trade_threads (
  thread_key text primary key,           -- 'gmail:<thread id>' or 'granola:<note id>'
  lot_id text references crm_bulk_trade_lots(id) on delete cascade,
  verdict text not null check (verdict in ('trade', 'none', 'unclear')),
  reason text,
  run_id bigint references crm_bulk_trade_check_runs(id) on delete set null,
  decided_at timestamptz not null default now(),
  check ((verdict = 'trade') = (lot_id is not null))
);
create index if not exists crm_bulk_trade_threads_lot_idx on crm_bulk_trade_threads (lot_id) where lot_id is not null;

alter table crm_bulk_trade_proposals
  add column if not exists applied_at timestamptz,
  -- What the change replaced, enough to reverse it: {"before": ..., "id": ...}
  add column if not exists undo jsonb;

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_status_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_status_check
  check (status in ('new', 'accepted', 'ignored', 'applied', 'undone'));

alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_kind_check check (kind in (
  'field', 'buyer_update', 'next_step', 'new_buyer', 'file', 'needs_triage', 'link_contact', 'possible_trade',
  'trade_kind', 'bid'
));
create index if not exists crm_bulk_trade_proposals_applied_idx on crm_bulk_trade_proposals (lot_id, applied_at desc)
  where status = 'applied';

alter table crm_bulk_trade_events drop constraint if exists crm_bulk_trade_events_kind_check;
alter table crm_bulk_trade_events add constraint crm_bulk_trade_events_kind_check check (kind in (
  'trade_created', 'trade_updated',
  'buyer_added', 'buyer_updated', 'bid_added',
  'contact_added', 'contact_updated', 'contact_removed',
  'field_updated', 'file_added', 'file_updated',
  'email_drafted', 'link_clicked',
  'proposal_accepted', 'proposal_ignored',
  'auto_applied', 'auto_undone', 'buyer_removed', 'bid_removed', 'file_removed'
));

commit;
