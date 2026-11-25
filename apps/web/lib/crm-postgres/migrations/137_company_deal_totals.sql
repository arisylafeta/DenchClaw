-- Deal totals per company (25 Nov 2026): how many deals a company has done with us and what they were worth.
--   total_deals: marketplace deals where they are our customer (buyer of a sale, supplier of a recycling deal; paid, collection
--     scheduled or completed, GBP/EUR 50 or more) + Trades Preview deals they bought (signed or later, or a demand closed
--     bought_from_us). Off-platform deals that exist only in email are not counted.
--   deal_value_gbp / deal_value_eur: the agreed amounts we hold, per currency (no conversion). Deals without an amount add to the
--     count only, so this is a known value, not a lifetime total.
-- Written daily by scripts/rebattery/company_deal_totals.py. Additive and idempotent.
begin;

alter table crm_companies add column if not exists total_deals integer;
alter table crm_companies add column if not exists deal_value_gbp numeric(14,2);
alter table crm_companies add column if not exists deal_value_eur numeric(14,2);

insert into crm_fields (id, object_id, name, type, canonical_column, description, sort_order)
select v.id, o.id, v.name, v.type, v.col, v.descr, v.sort
from crm_objects o, (values
  ('fld_company_total_deals', 'Total Deals', 'number', 'total_deals',
   'Deals done with us: marketplace deals as our customer (50+) and Trades Preview deals they bought. Off-platform deals in email only are not counted. Updated daily.', 9),
  ('fld_company_deal_value_gbp', 'Deal Value (GBP)', 'number', 'deal_value_gbp',
   'Known agreed value of those deals in GBP. Deals with no recorded amount are not included, so this is a known value, not a lifetime total.', 10),
  ('fld_company_deal_value_eur', 'Deal Value (EUR)', 'number', 'deal_value_eur',
   'Known agreed value of those deals in EUR (not converted to GBP). Updated daily.', 11)
) as v(id, name, type, col, descr, sort)
where o.name = 'company'
on conflict (object_id, name) do update set description = excluded.description,
  canonical_column = excluded.canonical_column, updated_at = now();

insert into crm_data_migrations (id) values ('137_company_deal_totals') on conflict do nothing;

commit;
