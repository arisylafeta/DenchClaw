-- Integrity rules the old demand and supply tables enforced, restated on crm_trade_listings (spec keys).
-- The compatibility views in 060 write through to this table, so the same bad writes are still refused.
-- Existing rows already satisfy the old rules, so the constraints are added validated.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_trade_listings
  add constraint crm_trade_listings_demand_basis_kind_check
    check (kind <> 'demand' or ((spec->>'intent' = 'standing') = (spec->>'basis' is not null))),
  add constraint crm_trade_listings_demand_needed_by_check
    check (kind <> 'demand' or spec->>'intent' = 'request' or spec->>'needed_by' is null),
  add constraint crm_trade_listings_demand_basis_check
    check (kind <> 'demand' or spec->>'basis' is null or spec->>'basis' in ('estimated', 'stated', 'agreed')),
  add constraint crm_trade_listings_demand_volume_check
    check (kind <> 'demand' or ((spec->>'volume' is null) = (spec->>'volume_unit' is null)
      and (spec->>'volume' is null or (spec->>'volume')::numeric > 0)
      and (spec->>'volume_unit' is null or spec->>'volume_unit' in ('packs', 'modules', 'cells', 'systems', 'kWh', 'MWh', 'tonnes')))),
  add constraint crm_trade_listings_demand_price_check
    check (kind <> 'demand' or ((spec->>'max_price' is null) = (spec->>'price_currency' is null)
      and (spec->>'max_price' is null) = (spec->>'price_unit' is null)
      and (spec->>'max_price' is null or (spec->>'max_price')::numeric > 0)
      and (spec->>'price_currency' is null or spec->>'price_currency' in ('EUR', 'USD', 'GBP'))
      and (spec->>'price_unit' is null or spec->>'price_unit' in ('kWh', 'pack', 'cell')))),
  add constraint crm_trade_listings_demand_fee_check
    check (kind <> 'demand' or ((spec->>'fee_eur' is null or (spec->>'fee_eur')::numeric >= 0)
      and (spec->>'price_basis' is null or spec->>'price_basis' in ('buyer', 'estimate'))
      and (spec->>'reputation' is null or spec->>'reputation' in ('paid', 'active', 'email', 'inbound', 'anon')))),
  add constraint crm_trade_listings_supply_spec_check
    check (kind <> 'supply' or ((spec->>'trade_kind' is null or spec->>'trade_kind' in ('packs', 'cells', 'systems'))
      and (spec->>'est_tonnes' is null or (spec->>'est_tonnes')::numeric >= 0)));

commit;
