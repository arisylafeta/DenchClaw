-- Cell format is part of a cell's product key (additive to 112/113, which stay as applied).
--
-- A cell ask "100,000 cells, 18650 or 21700" used to key broad:any-cells, so a pouch or prismatic lot looked like a
-- match. Now spec.cell_formats / spec.cell_format (also read from context and the trade fields) fan out one fact set
-- per stated format, and a cell fact with a format keys broad:[maker-]<format>-<chemistry>-cells, e.g.
-- broad:21700-any-cells, broad:18650-nmc-cells, broad:pouch-nmc-cells, broad:samsung-sdi-21700-nmc-cells. A stated
-- model with a cell maker still keys cell:<maker>-<model>. Without a cell format the key is exactly what 113 wrote.
-- Formats: 18650, 21700, 26650, 32700, 4680, cylindrical, prismatic, pouch. The TypeScript builder
-- (apps/web/lib/match/product-key-for.ts) mirrors this. Lines already written keep their keys until re-synced.
begin;

create or replace function buyer_interest_cell_format(value text) returns text language sql immutable as $$
  select case
    when t ~ '(^|[^0-9])18650([^0-9]|$)' then '18650'
    when t ~ '(^|[^0-9])(21700|2170)([^0-9]|$)' then '21700'
    when t ~ '(^|[^0-9])26650([^0-9]|$)' then '26650'
    when t ~ '(^|[^0-9])32700([^0-9]|$)' then '32700'
    when t ~ '(^|[^0-9])4680([^0-9]|$)' then '4680'
    when t ~ 'prismati' then 'prismatic'
    when t ~ 'pouch' then 'pouch'
    when t ~ '\y(cylindrical|round)\y' then 'cylindrical'
    else null end
  from (select lower(coalesce(value, '')) as t) x
$$;

-- Every distinct cell format a row states (lists first, then the single value), normalised, ordered.
create or replace function buyer_interest_cell_formats(p_spec jsonb, p_context jsonb, p_fields jsonb)
returns text[] language sql immutable as $$
  select coalesce(
    (select array_agg(distinct f order by f) from (
       select buyer_interest_cell_format(v) as f
       from unnest(buyer_interest_stated_list(p_spec->'cell_formats',
         buyer_interest_first_text(p_spec->'cell_format'),
         buyer_interest_first_text(p_context->'cell_format'),
         buyer_interest_first_text(p_fields->'cell_format'))) v) s
     where f is not null),
    array[null]::text[])
$$;

create or replace function buyer_interest_fact_sets(p_spec jsonb, p_context jsonb default '{}'::jsonb,
  p_fields jsonb default '{}'::jsonb, p_limit int default 12, p_title text default null)
returns table (facts jsonb[], stated_total int) language plpgsql immutable as $$
declare
  makes text[] := buyer_interest_make_list(buyer_interest_stated_list(p_spec->'makes', buyer_interest_first_text(p_spec->'make'),
    buyer_interest_first_text(p_context->'make'), buyer_interest_first_text(p_fields->'make')));
  chemists text[] := buyer_interest_stated_list(p_spec->'chemistries', buyer_interest_first_text(p_spec->'chemistry'),
    buyer_interest_first_text(p_context->'chemistry'), buyer_interest_first_text(p_fields->'chemistry'));
  formats text[] := buyer_interest_stated_list(p_spec->'formats', buyer_interest_first_text(p_spec->'format'),
    buyer_interest_first_text(p_context->'format'), buyer_interest_first_text(p_fields->'format'));
  cformats text[] := buyer_interest_cell_formats(p_spec, p_context, p_fields);
  sets jsonb[] := '{}';
  m text;
  c text;
  f text;
  cf text;
begin
  if makes = array[null]::text[] and buyer_interest_title_make(p_title) is not null then
    makes := array[buyer_interest_title_make(p_title)];
  end if;
  if formats = array[null]::text[] and buyer_interest_format(coalesce(buyer_interest_first_text(p_spec->'trade_kind'),
      buyer_interest_first_text(p_context->'trade_kind'))) is not null then
    formats := array[buyer_interest_format(coalesce(buyer_interest_first_text(p_spec->'trade_kind'),
      buyer_interest_first_text(p_context->'trade_kind')))];
  end if;
  for m, c, f, cf in
    select x.value, y.value, z.value, w.value
    from unnest(makes) x(value)
    cross join unnest(chemists) y(value)
    cross join unnest(formats) z(value)
    cross join unnest(cformats) w(value)
    order by 1 nulls first, 2 nulls first, 3 nulls first, 4 nulls first
    limit greatest(p_limit, 1)
  loop
    sets := sets || (buyer_interest_facts(
      p_spec || jsonb_build_object(
        'makes', case when m is null then '[]'::jsonb else jsonb_build_array(m) end, 'make', m,
        'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
        'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f),
      p_context, p_fields)
      || case when cf is null then '{}'::jsonb else jsonb_build_object('cell_format', cf) end);
  end loop;
  stated_total := cardinality(makes) * cardinality(chemists) * cardinality(formats) * cardinality(cformats);
  facts := sets;
  return next;
end $$;

create or replace function buyer_interest_product_key(facts jsonb) returns text language sql immutable as $$
  with kwh as (
    select coalesce(buyer_interest_number(facts->'kwh'),
      case when facts->>'kwh_min' is not null and facts->>'kwh_min' = facts->>'kwh_max'
        then buyer_interest_number(facts->'kwh_min') end) as value
  ), part as (
    select 'part:' || buyer_interest_part(part) as key
    from jsonb_array_elements_text(coalesce(facts->'part_numbers', '[]'::jsonb)) part
    where buyer_interest_part(part) is not null
    order by 1 limit 1
  ), wide as (
    select buyer_interest_model_wide_text(facts->>'make', facts->>'model') as model
  ), cellfmt as (
    select case when buyer_interest_format(facts->>'format') = 'cell'
      then buyer_interest_cell_format(facts->>'cell_format') end as value
  )
  select coalesce(
    (select key from part),
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold(buyer_interest_model_text(facts->>'model')) is not null
        and not buyer_interest_prose_model(facts->>'model')
        and (select value from kwh) is not null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_fold(buyer_interest_model_text(facts->>'model')) || '-'
        || buyer_interest_kwh_text((select value from kwh)) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null
        and buyer_interest_slug(facts->>'model') is not null
        and not buyer_interest_prose_model(facts->>'model')
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold((select model from wide)) is not null
        and not buyer_interest_prose_model((select model from wide))
        and (select value from kwh) is null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_fold((select model from wide)) end,
    -- Broad is the last level. A stated make stays on the key, so two makes in one ask keep two lines. A cell with a
    -- stated cell format adds it (and its cell maker when no make is stated) before the chemistry.
    'broad:' || coalesce(buyer_interest_make(facts->>'make') || '-',
        case when (select value from cellfmt) is not null then buyer_interest_slug(facts->>'cell_maker') || '-' end, '')
      || coalesce((select value from cellfmt) || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$$;

commit;
