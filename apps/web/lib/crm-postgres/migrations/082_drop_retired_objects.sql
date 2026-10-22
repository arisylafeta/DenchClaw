-- 082: generic CRM object registry cleanup.
--   bulk_trade: the retired Bulk Trades object over crm_bulk_trade_overview (frozen lots); Trades Preview replaces it
--     and ?path=bulk_trade links already redirect there. Its view goes too.
--   mail_message (reb_mail_message_object): a second object over the same mail_message table as email_message,
--     which is the one the app and agents use. Both are hidden from the sidebar.
-- crm_fields of both cascade. Backed up first (crm-cleanup-pre-20261022T142813Z-efc54dc6).
begin;
delete from crm_objects where id in ('reb_bulk_trade_object', 'reb_mail_message_object');
drop view if exists crm_bulk_trade_overview;
commit;
