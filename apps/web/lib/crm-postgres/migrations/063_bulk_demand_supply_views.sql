-- Final names for the typed demand and supply views over crm_bulk_listings.
--   crm_bulk_demand  : demand listings with their typed columns (read and write)
--   crm_bulk_supply  : supply listings (not pipeline trades) with their typed columns (read and write)
-- The old names stay as pass-through aliases until every caller has moved (a later migration drops them).
-- Demand activity is read and written on crm_bulk_listing_activity directly (column bulk_listing_id).
-- Apply only after a current backup and explicit schema approval.
begin;

alter view crm_bulk_trade_demand rename to crm_bulk_demand;
alter view crm_bulk_trade_supply rename to crm_bulk_supply;
alter trigger crm_bulk_trade_demand_write on crm_bulk_demand rename to crm_bulk_demand_write;
alter trigger crm_bulk_trade_supply_write on crm_bulk_supply rename to crm_bulk_supply_write;

create view crm_bulk_trade_demand as select * from crm_bulk_demand;
create view crm_bulk_trade_supply as select * from crm_bulk_supply;

grant select on crm_bulk_trade_demand, crm_bulk_trade_supply to crm_web_sql;
grant select, insert, update, delete on crm_bulk_trade_demand, crm_bulk_trade_supply to crm_agent_sql;

commit;
