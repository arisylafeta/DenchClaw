-- 082: remove the retired Bulk Trades object from the generic CRM registry.
--   bulk_trade: the object over crm_bulk_trade_overview (frozen lots); Trades Preview replaces it and
--     ?path=bulk_trade links already redirect there. Its view goes too; its crm_fields cascade.
-- The mail_message object stays: the generic object API reads mail through it with per-mailbox scoping.
-- Backed up first (crm-cleanup-pre-20261022T142813Z-efc54dc6).
begin;
delete from crm_objects where id = 'reb_bulk_trade_object';
drop view if exists crm_bulk_trade_overview;
commit;
