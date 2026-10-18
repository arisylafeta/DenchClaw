-- Seller references are namespaced identities: company:<crm company id>, supply:<supply id>,
-- stock:<stock item id>. Names can be known without a resolved identity.
-- Schema application replays migrations; backfill once, never overwrite curated identities.
do $$ begin
if not exists (select 1 from information_schema.columns where table_schema = 'public'
  and table_name = 'crm_bulk_trade_lots' and column_name = 'origin') then
alter table crm_bulk_trade_lots add column origin text not null default 'supply' check (origin in ('supply', 'demand'));
alter table crm_bulk_trade_lots add column seller_ref text check (seller_ref ~ '^(company|supply|stock):.+$');
alter table crm_bulk_trade_lots add column seller_name text;
update crm_bulk_trade_lots set origin = lot_kind;
update crm_bulk_trade_lots lot set seller_name = coalesce(
  (select nullif(p.display_name, '') from crm_bulk_trade_parties p where p.lot_id = lot.id and p.role = 'supplier' order by p.latest_evidence_at desc nulls last, p.id limit 1),
  nullif(lot.source_manifest->>'supplier', ''),
  (select nullif(f.value, '') from crm_bulk_trade_fields f where f.lot_id = lot.id and f.field_key in ('supplier', 'seller') order by f.updated_at desc limit 1),
  (select coalesce(nullif(c.company, ''), nullif(c.name, '')) from crm_bulk_trade_contacts c where c.lot_id = lot.id order by c.sort_order, c.id limit 1)
) where lot.origin = 'supply';
update crm_bulk_trade_lots lot set seller_ref = 'company:' || coalesce(
  (select p.company_id from crm_bulk_trade_parties p where p.lot_id = lot.id and p.role = 'supplier' and p.company_id is not null order by p.latest_evidence_at desc nulls last, p.id limit 1),
  (select c.id from crm_companies c where lower(c.name) = lower(lot.seller_name) order by c.id limit 1),
  (select person.company_id from crm_bulk_trade_contacts contact join crm_people person on lower(person.email) = lower(contact.email) where contact.lot_id = lot.id and person.company_id is not null order by contact.sort_order, person.id limit 1)
) where lot.origin = 'supply';
end if;
end $$;

-- Normalized, append-only context: separate from the mutable buyer profile, with provenance per note.
create table if not exists crm_company_context_notes (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  note text not null check (length(trim(note)) > 0),
  source_kind text not null,
  source_ref text,
  observed_on date not null,
  created_at timestamptz not null default now()
);
create index if not exists crm_company_context_notes_company_idx on crm_company_context_notes(company_id, observed_on desc, created_at desc);
alter table crm_bulk_trade_demand add column if not exists priority boolean not null default false;

-- One row per available batch, sell-side trade/auction, or supplier-stock family.
-- A promoted batch is represented by its trade, not twice. Stock is unverified unless every row is confirmed.
create or replace view crm_bulk_trade_supply_feed as
select supply.id, 'supply'::text as kind, supply.offers as title, supply.seller,
  supply.quantity as size, supply.location, supply.observed_on::text as seen, supply.status,
  '/?path=bulk_trade&supply=' || supply.id as href, array[supply.seller]::text[] as suppliers,
  null::boolean as verified, null::int as count
from crm_bulk_trade_supply supply where supply.status = 'open'
union all
select lot.id, case when lot.auction_id is not null then 'auction' else 'trade' end,
  lot.title, lot.seller_name,
  coalesce((select nullif(field.value, '') from crm_bulk_trade_fields field where field.lot_id = lot.id and field.field_key = 'quantity'), nullif(concat_ws(' ', lot.observed_quantity::text, lot.quantity_unit), '')),
  (select field.value from crm_bulk_trade_fields field where field.lot_id = lot.id and field.field_key = 'location'),
  coalesce(lot.latest_activity_at, lot.updated_at)::text, lot.trade_stage,
  '/?path=bulk_trade&trade=' || lot.id, array_remove(array[lot.seller_name]::text[], null), null::boolean, null::int
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
