-- Company names are the canonical display label, not email addresses or imported domain labels.
update crm_companies set name = case lower(name)
  when 'greenloopenergy.co.uk' then 'GreenLoop Energy'
  when 'armex-energy.co.uk' then 'Armex Energy'
  when 'stellantis.com' then 'Stellantis'
  when 'whs-energy.com' then 'WHS Energy'
  when 'eecc' then 'EECC'
end
where lower(name) in ('greenloopenergy.co.uk', 'armex-energy.co.uk', 'stellantis.com', 'whs-energy.com', 'eecc');

-- Shared by board/detail and the supply feed, so future company renames stay in sync.
-- A domain/email is only a display fallback for an already attributed seller, never identity evidence.
create or replace function bulk_trade_seller_display(reference text, fallback text)
returns text language sql stable as $$
  select coalesce(
    (select nullif(trim(company.name), '') from crm_companies company where reference = 'company:' || company.id),
    case when fallback ~ '^[^[:space:]]+@[^[:space:]]+\.[[:alpha:]]+$'
        or fallback ~ '^[[:alnum:]][[:alnum:].-]*\.[[:alpha:]]{2,}$'
      then initcap(regexp_replace(regexp_replace(regexp_replace(
        split_part(fallback, '@', case when position('@' in fallback) > 0 then 2 else 1 end),
        '^www\.', '', 'i'), '(\.(co|com|org|net))?\.[^.]+$', '', 'i'), '[-_.]+', ' ', 'g'))
      else nullif(trim(fallback), '') end
  )
$$;

update crm_bulk_trade_lots set seller_name = bulk_trade_seller_display(seller_ref, seller_name)
where seller_name is distinct from bulk_trade_seller_display(seller_ref, seller_name);

create or replace view crm_bulk_trade_supply_feed as
select supply.id, 'supply'::text as kind, supply.offers as title, supply.seller,
  supply.quantity as size, supply.location, supply.observed_on::text as seen, supply.status,
  '/?path=bulk_trade&supply=' || supply.id as href, array[supply.seller]::text[] as suppliers,
  null::boolean as verified, null::int as count
from crm_bulk_trade_supply supply where supply.status = 'open'
union all
select lot.id, case when lot.auction_id is not null then 'auction' else 'trade' end,
  lot.title, bulk_trade_seller_display(lot.seller_ref, lot.seller_name),
  coalesce((select nullif(field.value, '') from crm_bulk_trade_fields field where field.lot_id = lot.id and field.field_key = 'quantity'), nullif(concat_ws(' ', lot.observed_quantity::text, lot.quantity_unit), '')),
  (select field.value from crm_bulk_trade_fields field where field.lot_id = lot.id and field.field_key = 'location'),
  coalesce(lot.latest_activity_at, lot.updated_at)::text, lot.trade_stage,
  '/?path=bulk_trade&trade=' || lot.id,
  array_remove(array[bulk_trade_seller_display(lot.seller_ref, lot.seller_name)]::text[], null), null::boolean, null::int
from crm_bulk_trade_lots lot where lot.origin = 'supply'
  and lot.trade_stage in ('Needs info', 'With buyers', 'Closing')
  and (lot.auction_id is null or (lot.auction_status = 'published' and (lot.auction_closes_at is null or lot.auction_closes_at > now())))
union all
select 'stock:' || coalesce(nullif(trim(concat_ws(' ', stock.make, stock.model)), ''), 'Unspecified family'), 'stock',
  coalesce(nullif(trim(concat_ws(' ', stock.make, stock.model)), ''), 'Unspecified family'),
  string_agg(distinct stock.supplier, ', ' order by stock.supplier),
  count(*)::text || ' stock rows', string_agg(distinct nullif(stock.location, ''), ', '), max(stock.updated_at)::text,
  case when bool_and(coalesce(stock.supplier_confirmed, false)) then 'verified' else 'unverified' end,
  '/?path=stock', array_agg(distinct stock.supplier order by stock.supplier),
  bool_and(coalesce(stock.supplier_confirmed, false)), count(*)::int
from crm_stock_items stock where stock.stock_status not in ('sold', 'unavailable')
group by coalesce(nullif(trim(concat_ws(' ', stock.make, stock.model)), ''), 'Unspecified family');
