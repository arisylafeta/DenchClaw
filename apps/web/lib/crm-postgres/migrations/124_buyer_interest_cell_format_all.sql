-- A request that lists all three cell families (prismatic, cylindrical, pouch) says "any dimensions": its line has no
-- cell format (broad:nmc-cells), not one line per family. Two or more formats short of all three keep one line each (119),
-- and specific sizes (18650, 21700) keep the 119 behaviour. Only buyer_interest_cell_formats changes; the fact sets
-- and the product key already read it. The TypeScript builder (match/product-key-for.ts statedCellFormats) mirrors this.
-- Lines already written keep their keys until re-synced.
begin;

create or replace function buyer_interest_cell_formats(p_spec jsonb, p_context jsonb, p_fields jsonb)
returns text[] language sql immutable as $$
  with found as (
    select array_agg(distinct f order by f) as formats from (
      select buyer_interest_cell_format(v) as f
      from unnest(buyer_interest_stated_list(p_spec->'cell_formats',
        buyer_interest_first_text(p_spec->'cell_format'),
        buyer_interest_first_text(p_context->'cell_format'),
        buyer_interest_first_text(p_fields->'cell_format'))) v) s
    where f is not null)
  select case
    when formats is null then array[null]::text[]
    when formats @> array['cylindrical', 'pouch', 'prismatic'] then array[null]::text[]
    else formats end
  from found
$$;

commit;
