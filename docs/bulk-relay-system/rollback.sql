-- Rollback for migrations 116, 117, 118 and 119 (bulk and Relay system). Not a migration: nothing applies it by itself.
-- See rollback.md for when to use it. Safe to run twice.
--
-- What it does: drops every trigger those migrations added, and puts back the pre-116 bodies of the two SQL functions
-- they replaced, bulk_listing_stage (as in migration 096) and bulk_listing_qualified (as in migration 085), taken from
-- origin/main. The old web build then reads the stage names it knows (Offered, Negotiating, Agreed, Paid, Delivered,
-- Available, Sourcing, Can't source).
--
-- What it leaves: the new tables (crm_bulk_stage_events, crm_bulk_matches), the new columns and constraints, the new
-- helper functions (unused once the triggers are gone) and the data in them. Nothing is deleted. To go forward again,
-- apply 116, 117, 118 and 119 in order; each is safe to run twice.
begin;

drop trigger if exists bulk_offer_paid_facts on crm_bulk_offers;
drop trigger if exists bulk_offer_stage_events on crm_bulk_offers;
drop trigger if exists bulk_match_offered on crm_bulk_offers;
drop trigger if exists bulk_listing_stage_events on crm_bulk_listings;
drop trigger if exists bulk_listing_field_stage_events on crm_bulk_listing_fields;
do $$
begin
  if to_regclass('crm_bulk_matches') is not null then
    drop trigger if exists bulk_match_check_reservation on crm_bulk_matches;
    drop trigger if exists bulk_match_stage_events on crm_bulk_matches;
  end if;
end $$;

-- From migration 085 (origin/main), unchanged.
create or replace function bulk_listing_qualified(listing_id text) returns boolean language sql stable as $$
  select coalesce((select case
    when l.kind = 'demand' then l.status <> 'qualifying'
      and (l.company_id is not null or l.person_id is not null)
      and (l.spec->>'volume' is not null or nullif(btrim(coalesce(l.quantity, '')), '') is not null)
      and nullif(l.spec->>'product_family', '') is not null
    else (l.company_id is not null or l.person_id is not null)
      and nullif(btrim(coalesce(l.quantity, '')), '') is not null
      and nullif(btrim(coalesce(l.location, '')), '') is not null
      and exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id
        and f.field_key in ('soh', 'test_data') and nullif(btrim(coalesce(f.value, '')), '') is not null and f.status <> 'missing')
    end from crm_bulk_listings l where l.id = listing_id), false)
$$;

-- From migration 096 (origin/main), unchanged.
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
