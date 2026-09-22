begin;

-- REB-346: single DenchClaw stock table for all supplier stock.
-- Common scalar columns plus a free-form `attributes` JSONB extension point
-- whose exact schema is defined later without a rebuild.

create table if not exists crm_stock_items (
  id text primary key,
  supplier text not null,
  stock_id text not null,
  make text,
  model text,
  model_detail text,
  year text,
  powertrain text,
  part_number text,
  description text,
  quantity numeric not null default 1,
  price numeric,
  location text,
  condition text,
  comments text,
  aged_12m boolean not null default false,
  in_august boolean not null default false,
  in_september_aged boolean not null default false,
  listing_id text,
  enrich_status text not null default 'pending',
  enrich_attempts integer not null default 0,
  enriched_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_stock_items_supplier_stock_uidx unique (supplier, stock_id),
  constraint crm_stock_items_enrich_status_check
    check (enrich_status in ('pending', 'enriched', 'failed'))
);

create index if not exists crm_stock_items_enrich_status_idx
  on crm_stock_items(enrich_status);
create index if not exists crm_stock_items_make_model_idx
  on crm_stock_items(make, model);
create index if not exists crm_stock_items_part_number_idx
  on crm_stock_items(part_number);

-- One queue row per stock item. The trigger below re-queues an item whenever
-- it is created or a watched column changes, so enrichment fires exactly once
-- per new/changed row and leaves a traceable state.

create table if not exists crm_stock_enrich_queue (
  stock_item_id text primary key references crm_stock_items(id) on delete cascade,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_stock_enrich_queue_status_check
    check (status in ('pending', 'claimed', 'done', 'failed'))
);

create index if not exists crm_stock_enrich_queue_status_next_idx
  on crm_stock_enrich_queue(status, next_attempt_at);

create or replace function crm_stock_items_queue_enrichment()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'insert' then
    insert into crm_stock_enrich_queue (stock_item_id, status, next_attempt_at, updated_at)
    values (new.id, 'pending', now(), now())
    on conflict (stock_item_id)
    do update set status = 'pending', next_attempt_at = now(), updated_at = now();
    return new;
  end if;
  if new.supplier is distinct from old.supplier
    or new.stock_id is distinct from old.stock_id
    or new.make is distinct from old.make
    or new.model is distinct from old.model
    or new.model_detail is distinct from old.model_detail
    or new.year is distinct from old.year
    or new.powertrain is distinct from old.powertrain
    or new.part_number is distinct from old.part_number
    or new.description is distinct from old.description
    or new.quantity is distinct from old.quantity
    or new.price is distinct from old.price
    or new.location is distinct from old.location
    or new.condition is distinct from old.condition
    or new.comments is distinct from old.comments
    or new.aged_12m is distinct from old.aged_12m
    or new.in_august is distinct from old.in_august
    or new.in_september_aged is distinct from old.in_september_aged
    or new.listing_id is distinct from old.listing_id
    or new.attributes is distinct from old.attributes
  then
    insert into crm_stock_enrich_queue (stock_item_id, status, next_attempt_at, updated_at)
    values (new.id, 'pending', now(), now())
    on conflict (stock_item_id)
    do update set status = 'pending', next_attempt_at = now(), updated_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists crm_stock_items_enrichment_trigger on crm_stock_items;
create trigger crm_stock_items_enrichment_trigger
  after insert or update on crm_stock_items
  for each row execute function crm_stock_items_queue_enrichment();

-- Register the generic object so entry-read/entry-mutations resolve the table
-- through entity_table with no app-code change.

insert into crm_objects (id, name, description, display_field, sort_order, entity_table)
values (
  'reb_stock_object',
  'stock',
  'All supplier stock in one place: common fields plus variable attributes, with automatic enrichment queueing.',
  'Stock ID',
  91,
  'crm_stock_items'
)
on conflict (id) do update set
  description = excluded.description,
  display_field = excluded.display_field,
  sort_order = excluded.sort_order,
  entity_table = excluded.entity_table,
  updated_at = now();

insert into crm_fields (id, object_id, name, type, canonical_column, sort_order) values
  ('reb_stock_fld_00001', 'reb_stock_object', 'Stock ID', 'text', 'stock_id', 0),
  ('reb_stock_fld_00002', 'reb_stock_object', 'Supplier', 'text', 'supplier', 1),
  ('reb_stock_fld_00003', 'reb_stock_object', 'Make', 'text', 'make', 2),
  ('reb_stock_fld_00004', 'reb_stock_object', 'Model', 'text', 'model', 3),
  ('reb_stock_fld_00005', 'reb_stock_object', 'Model Detail', 'text', 'model_detail', 4),
  ('reb_stock_fld_00006', 'reb_stock_object', 'Year', 'text', 'year', 5),
  ('reb_stock_fld_00007', 'reb_stock_object', 'Powertrain', 'text', 'powertrain', 6),
  ('reb_stock_fld_00008', 'reb_stock_object', 'Part Number', 'text', 'part_number', 7),
  ('reb_stock_fld_00009', 'reb_stock_object', 'Description', 'text', 'description', 8),
  ('reb_stock_fld_00010', 'reb_stock_object', 'Quantity', 'number', 'quantity', 9),
  ('reb_stock_fld_00011', 'reb_stock_object', 'Price', 'number', 'price', 10),
  ('reb_stock_fld_00012', 'reb_stock_object', 'Location', 'text', 'location', 11),
  ('reb_stock_fld_00013', 'reb_stock_object', 'Condition', 'text', 'condition', 12),
  ('reb_stock_fld_00014', 'reb_stock_object', 'Comments', 'text', 'comments', 13),
  ('reb_stock_fld_00015', 'reb_stock_object', 'Aged 12m', 'boolean', 'aged_12m', 14),
  ('reb_stock_fld_00016', 'reb_stock_object', 'In August', 'boolean', 'in_august', 15),
  ('reb_stock_fld_00017', 'reb_stock_object', 'In September Aged', 'boolean', 'in_september_aged', 16),
  ('reb_stock_fld_00018', 'reb_stock_object', 'Listing ID', 'text', 'listing_id', 17),
  ('reb_stock_fld_00019', 'reb_stock_object', 'Enrich Status', 'text', 'enrich_status', 18)
on conflict (id) do update set
  name = excluded.name,
  type = excluded.type,
  canonical_column = excluded.canonical_column,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;
