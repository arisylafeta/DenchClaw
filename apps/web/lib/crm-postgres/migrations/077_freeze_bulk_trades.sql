-- Freeze the retired Bulk Trades tables. Their data was copied into the Trades Preview listing tables
-- (scripts/rebattery/reconcile_bulk_trades.py, clean on 22 Oct 2026) and no code writes them any more.
-- Nothing is deleted: the tables stay readable. Any insert, update, delete or truncate now fails loudly.
-- Still writable on purpose (inbox and matching queues used by Trades Preview): crm_bulk_trade_proposals,
-- crm_bulk_trade_check_runs, crm_bulk_trade_demand_matches, crm_bulk_trade_supply_matches.
-- To unfreeze for a repair: set local bulk.allow_frozen_write = 'on' inside the repair transaction.
begin;

-- Last fill of the lot-level columns on listings (same as migration 071; only empty listing values are filled).
update crm_bulk_listings l set
  value = coalesce(l.value, lot.value),
  waiting_on = coalesce(l.waiting_on, lot.waiting_on),
  waiting_since = coalesce(l.waiting_since, lot.waiting_since),
  hold_until = coalesce(l.hold_until, lot.hold_until),
  hold_reason = coalesce(l.hold_reason, lot.hold_reason),
  auction_id = coalesce(l.auction_id, lot.auction_id),
  auction_slug = coalesce(l.auction_slug, lot.auction_slug),
  auction_status = coalesce(l.auction_status, lot.auction_status),
  auction_closes_at = coalesce(l.auction_closes_at, lot.auction_closes_at),
  clear_by = coalesce(l.clear_by, lot.clear_by),
  ship_by = coalesce(l.ship_by, lot.ship_by),
  marketplace_listing_id = coalesce(l.marketplace_listing_id, lot.listing_id)
from crm_bulk_trade_lots lot
where lot.id = l.id;

create or replace function reject_frozen_bulk_trades_write() returns trigger language plpgsql as $$
begin
  -- The disposable test database (scripts/rebattery/crm-test-db.sh) sets this so the old-path tests can still seed rows.
  if current_setting('bulk.allow_frozen_write', true) = 'on' then
    return null;
  end if;
  raise exception '% is frozen: Bulk Trades was retired on 22 Oct 2026. Write to the Trades Preview tables (crm_bulk_listings, crm_bulk_listing_fields, crm_bulk_offers, crm_bulk_listing_activity, crm_bulk_thread_links).', tg_table_name
    using errcode = 'read_only_sql_transaction';
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'crm_bulk_trade_lots', 'crm_bulk_trade_fields', 'crm_bulk_trade_contacts', 'crm_bulk_trade_buyers', 'crm_bulk_trade_events',
    'crm_bulk_trade_bids', 'crm_bulk_trade_threads', 'crm_bulk_trade_evidence_links', 'crm_bulk_trade_parties',
    'crm_bulk_trade_auction_people', 'crm_bulk_trade_links', 'crm_bulk_trade_files_legacy', 'crm_bulk_trade_demand_legacy',
    'crm_bulk_trade_demand_activity_legacy', 'crm_bulk_trade_supply_legacy']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists %I on %I', t || '_frozen', t);
    execute format('create trigger %I before insert or update or delete on %I for each statement execute function reject_frozen_bulk_trades_write()', t || '_frozen', t);
    execute format('drop trigger if exists %I on %I', t || '_frozen_truncate', t);
    execute format('create trigger %I before truncate on %I for each statement execute function reject_frozen_bulk_trades_write()', t || '_frozen_truncate', t);
  end loop;
end $$;

commit;
