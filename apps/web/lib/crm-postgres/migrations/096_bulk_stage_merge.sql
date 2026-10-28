-- 096: fewer early stages (Ari, 28 Oct 2026).
--   Requests: Found is gone. A request with a candidate supplier or a saved match is Sourcing until it is offered.
--   Supply: Qualified and Available are one stage, Available.
-- Demand: New, Qualified, Sourcing, Can't source. Supply: New, Available. Both then Offered, Negotiating, Agreed, Paid, Delivered.
-- Nothing is stored: the stage stays computed. The UI maps Found and supply Qualified itself, so either may go live first.
begin;

create or replace function bulk_listing_stage(listing_id text) returns text language sql stable as $$
  select case
    when r.rank = 6 then 'Delivered'
    when r.rank = 5 then 'Paid'
    when r.rank = 4 then 'Agreed'
    when r.rank = 3 then 'Negotiating'
    when r.rank = 2 then 'Offered'
    when l.kind = 'demand' then case
      when nullif(btrim(coalesce(l.context->>'cant_source', '')), '') is not null then 'Can''t source'
      when r.rank = 1 or x.matched then 'Sourcing'
      when x.qualified and nullif(btrim(coalesce(l.context->>'owner', '')), '') is not null then 'Sourcing'
      when x.qualified then 'Qualified'
      else 'New' end
    else case
      when r.rank = 1 or x.matched or x.qualified then 'Available'
      else 'New' end
    end
  from (select coalesce((select max(case o.stage when 'complete' then 6 when 'paid' then 5
          when 'invoiced' then 4 when 'signed' then 4 when 'contract_out' then 4
          when 'negotiating' then 3 when 'offered' then 2 when 'candidate' then 1 end)
        from crm_bulk_offers o where o.role = 'counterparty' and (o.bulk_listing_id = listing_id or o.counterpart_id = listing_id)), 0) as rank
    ) r
  cross join lateral (select
      case when r.rank < 2 then
        exists (select 1 from crm_bulk_trade_demand_matches m where not m.hidden and (m.demand_id = listing_id or m.lot_id = listing_id))
        or exists (select 1 from crm_bulk_trade_supply_matches m where not m.hidden and (m.supply_id = listing_id or m.demand_id = listing_id))
      else false end as matched,
      case when r.rank < 2 then bulk_listing_qualified(listing_id) else false end as qualified
    ) x
  left join crm_bulk_listings l on l.id = listing_id
$$;

commit;
