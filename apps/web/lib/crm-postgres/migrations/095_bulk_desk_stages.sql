-- 095: Bulk desk stages. Requests (demand) and Supply each get their own early stages; both share the deal stages.
--   Demand: New, Qualified, Sourcing, Found, Can't source, then the deal stages.
--   Supply: New, Qualified, Available, then the deal stages.
--   Deal stages (the Board): Offered, Negotiating, Agreed, Paid, Delivered.
-- Adds the offer stage `negotiating` between offered and contract_out. Nothing is stored: the stage stays computed.
-- Replaces bulk_listing_stage() from 085; bulk_listing_qualified() and the saved-match rule are unchanged.
-- No view or function reads the stage strings; the only SQL readers of offer stages (crm_bulk_listing_supply_feed,
-- crm_buyer_engagement) look at contract_out and later, which keep their meaning.
-- The UI maps the pre-095 labels (Matched, Signed & Paid, Complete) itself, so either may go live first.
begin;

alter table crm_bulk_offers drop constraint if exists crm_bulk_offers_stage_check;
alter table crm_bulk_offers add constraint crm_bulk_offers_stage_check check (stage is null or stage = any (array[
  'candidate', 'offered', 'negotiating', 'contract_out', 'signed', 'invoiced', 'paid', 'complete', 'declined', 'lost']));

-- The listing stage. The furthest counterparty offer on the listing, or pointing at it, wins for both kinds:
-- complete Delivered, paid Paid, contract_out/signed/invoiced Agreed, negotiating Negotiating, offered Offered.
-- Otherwise demand: Can't source (context.cant_source has a reason), Found (a candidate offer or a saved match),
-- Sourcing (qualified with an owner), Qualified, New. Supply: Available (a candidate, a saved match, or qualified
-- with an owner), Qualified, New. The qualified and saved-match checks run once, and only below Offered.
create or replace function bulk_listing_stage(listing_id text) returns text language sql stable as $$
  select case
    when r.rank = 6 then 'Delivered'
    when r.rank = 5 then 'Paid'
    when r.rank = 4 then 'Agreed'
    when r.rank = 3 then 'Negotiating'
    when r.rank = 2 then 'Offered'
    when l.kind = 'demand' then case
      when nullif(btrim(coalesce(l.context->>'cant_source', '')), '') is not null then 'Can''t source'
      when r.rank = 1 or x.matched then 'Found'
      when x.qualified and nullif(btrim(coalesce(l.context->>'owner', '')), '') is not null then 'Sourcing'
      when x.qualified then 'Qualified'
      else 'New' end
    else case
      when r.rank = 1 or x.matched or (x.qualified and nullif(btrim(coalesce(l.context->>'owner', '')), '') is not null) then 'Available'
      when x.qualified then 'Qualified'
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
