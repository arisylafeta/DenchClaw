-- 081: drop copies and leftovers nothing reads (backed up first: crm-cleanup-pre-20261022T142813Z-efc54dc6).
--   *_legacy tables: pre-cutover copies of demand, supply, demand activity and files (migration 060); every row
--     lives in crm_bulk_listings / _activity / _documents (the 82 legacy files are byte-identical documents).
--   crm_tag_archive: tags archived in April, read by nothing.
--   crm_supply_update_list: unused view.
--   crm_bulk_trade_supply_feed, crm_bulk_trade_seller_candidates: views over the frozen lots;
--     crm_bulk_listing_supply_feed replaces the feed.
--   crm_bulk_trade_buyer_waiting: same columns as crm_bulk_buyer_waiting, which reads Trades Preview.
begin;
drop view if exists crm_bulk_trade_supply_feed;
drop view if exists crm_bulk_trade_seller_candidates;
drop view if exists crm_bulk_trade_buyer_waiting;
drop view if exists crm_supply_update_list;
drop table if exists crm_bulk_trade_demand_activity_legacy;
drop table if exists crm_bulk_trade_demand_legacy;
drop table if exists crm_bulk_trade_supply_legacy;
drop table if exists crm_bulk_trade_files_legacy;
drop table if exists crm_tag_archive;
commit;
