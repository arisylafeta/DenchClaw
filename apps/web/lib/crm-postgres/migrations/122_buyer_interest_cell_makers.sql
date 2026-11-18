-- Wants sync rules, part 3 (follows 117, 119, 120 and 121, which stay as applied).
--
-- 1. A request or offer that states a cell maker (spec.cell_makers) and no make keeps the maker on its broad key:
--    broad:panasonic-any-cells, broad:calb-any-cells, broad:catl-any-modules. Until now the maker rode only on a line that
--    also stated a cell format, so "Panasonic cells" collapsed into broad:any-cells. Several cell makers write one line
--    each (the fact sets cross them with the formats, as they cross makes). Mirrored in product-key-for.ts.
-- 2. A model list with no make (spec.models ['2008', 'Berlingo', 'Zoe', ...]) resolves each entry's make from the alias
--    list instead of dropping every entry whose name alone does not tell the make (buyer_interest_text_models p_any).
-- 3. A capacity the text states for a format ("50kWh packs" in spec.product_family) rides on that format's line.
-- 4. A model that is only four digits (Peugeot 2008, 3008, 5008) is a model, not a year: it is no longer prose.
begin;
set local lock_timeout = '3s';

create or replace function buyer_interest_prose_model(value text) returns boolean language sql immutable as $$
  select coalesce(btrim(coalesce(value, '')) <> '' and (
    btrim(value) ~ '[(),;/:]'
    or cardinality(regexp_split_to_array(btrim(value), '\s+')) >= 4
    or (btrim(value) ~ '\y(19|20)[0-9]{2}\y' and btrim(value) !~ '^[0-9]{4}$')), false)
$$;

drop function if exists buyer_interest_text_models(text, text[]);
create or replace function buyer_interest_text_models(p_text text, p_makes text[] default '{}', p_any boolean default false)
returns table (own text, make_display text, slug text, name text, kwh numeric) language plpgsql stable as $$
declare
  -- A kWh group: values joined by / , & or and, the last one followed by kWh. Earlier values have two or three digits
  -- (so "Model 3, 75 kWh" is Model 3 and 75).
  kwh_re constant text := '(?:(?:[0-9]{2,3}(?:\.[0-9]+)?|[0-9]\.[0-9]+)(?:\s*kwh)?\s*(?:/|,|&|\yor\y|\yand\y)\s*)*[0-9]+(?:\.[0-9]+)?\s*kwh';
  text_ text := regexp_replace(coalesce(p_text, ''), '[(\[]([^)\]]*[0-9]\s*kwh[^)\]]*)[)\]]', ' \1 ', 'gi');
  grp text[];
  grp_vals jsonb[] := '{}';
  grp_pos int[] := '{}';
  g int;
  words text;
  hints text[] := '{}';
  word text;
  piece text;
  r record;
  pos int;
  seen text[] := '{}';
  f_own text[] := '{}'; f_disp text[] := '{}'; f_slug text[] := '{}'; f_name text[] := '{}'; f_pos int[] := '{}'; f_len int[] := '{}';
  n int;
  ord int[];
  k int;
  idx int;
  next_pos int;
  mine jsonb[];
  assigned jsonb[];
  between_ text;
  v text;
begin
  -- Each kWh group becomes one placeholder word, so its place among the models is known.
  for grp in select regexp_matches(text_, '(' || kwh_re || ')', 'gi') loop
    grp_vals := grp_vals || coalesce((select jsonb_agg(distinct x::numeric) from unnest(regexp_split_to_array(
      regexp_replace(lower(grp[1]), '\s*kwh|\s+', '', 'g'), '/|,|&|or|and')) x where x ~ '^[0-9]+(\.[0-9]+)?$'), '[]'::jsonb);
  end loop;
  g := 0;
  words := text_;
  loop
    exit when g >= cardinality(grp_vals);
    g := g + 1;
    words := regexp_replace(words, kwh_re, ' zkwh' || g || 'z ', 'i');
  end loop;
  words := regexp_replace(words, '\([^)]*\)|\[[^\]]*\]', ' ', 'g');
  words := ' ' || btrim(regexp_replace(buyer_interest_unaccent(words), '[^a-z0-9]+', ' ', 'g')) || ' ';
  foreach word in array string_to_array(btrim(words), ' ') loop
    hints := hints || buyer_interest_alias_make_fold(word);
  end loop;
  foreach word in array coalesce(p_makes, '{}') loop
    foreach piece in array regexp_split_to_array(coalesce(word, ''), '\s*(,|/|&|\yand\y|\yor\y)\s*', 'i') loop
      hints := hints || buyer_interest_alias_make_fold(piece);
      if buyer_interest_make(piece) = 'vw-group' then hints := hints || array['volkswagen', 'audi', 'skoda', 'seat', 'cupra', 'porsche']; end if;
    end loop;
  end loop;
  for r in select * from buyer_interest_model_alias a order by length(a.alias_spaced) desc, a.ord loop
    -- p_any: an entry of an explicit model list that names no make may take the make of any model the list knows.
    if not (r.own = any(hints) or r.alone or (p_any and r.is_global)) then continue; end if;
    pos := position(' ' || r.alias_spaced || ' ' in words);
    if pos = 0 then continue; end if;
    words := overlay(words placing repeat(' ', length(r.alias_spaced)) from pos + 1 for length(r.alias_spaced));
    if (r.own || '/' || r.slug) = any(seen) then continue; end if;
    seen := seen || (r.own || '/' || r.slug);
    f_own := f_own || r.own; f_disp := f_disp || r.make_display; f_slug := f_slug || r.slug; f_name := f_name || r.name;
    f_pos := f_pos || (pos + 1); f_len := f_len || length(r.alias_spaced);
  end loop;

  n := cardinality(f_pos);
  if n = 0 then return; end if;
  for g in 1..cardinality(grp_vals) loop
    grp_pos := grp_pos || position(' zkwh' || g || 'z ' in words);
  end loop;
  ord := array(select i from generate_subscripts(f_pos, 1) i order by f_pos[i]);
  assigned := array_fill('[]'::jsonb, array[n]);
  for k in reverse n..1 loop
    idx := ord[k];
    next_pos := case when k < n then f_pos[ord[k + 1]] else length(words) + 2 end;
    mine := '{}';
    for g in 1..cardinality(grp_vals) loop
      if grp_pos[g] >= f_pos[idx] + f_len[idx] and grp_pos[g] < next_pos then mine := mine || grp_vals[g]; end if;
    end loop;
    if cardinality(mine) = 0 and k < n then
      between_ := substr(words, f_pos[idx] + f_len[idx], next_pos - f_pos[idx] - f_len[idx]);
      if between_ ~ '^\s*((and|or)\s*)?$' then assigned[idx] := assigned[ord[k + 1]]; end if;
    end if;
    if cardinality(mine) = 0 and k = 1 and n = 1 then
      for g in 1..cardinality(grp_vals) loop mine := mine || grp_vals[g]; end loop;
    end if;
    if cardinality(mine) > 0 then
      assigned[idx] := (select jsonb_agg(distinct x::numeric) from unnest(mine) m, jsonb_array_elements_text(m) x);
    end if;
  end loop;

  for k in 1..n loop
    idx := ord[k];
    own := f_own[idx]; make_display := f_disp[idx]; slug := f_slug[idx]; name := f_name[idx];
    if jsonb_array_length(assigned[idx]) = 0 then
      kwh := null;
      return next;
    else
      for v in select x from jsonb_array_elements_text(assigned[idx]) x order by x::numeric loop
        kwh := v::numeric;
        return next;
      end loop;
    end if;
  end loop;
end $$;


create or replace function buyer_interest_format_kwh(p_text text, p_format text) returns jsonb
language plpgsql immutable as $$
declare
  m text[];
  vals numeric[] := '{}';
begin
  if nullif(btrim(coalesce(p_text, '')), '') is null or buyer_interest_format(p_format) is null then return null; end if;
  for m in select regexp_matches(p_text, '([0-9]+(?:\.[0-9]+)?)\s*kwh\s+(?:[a-z0-9-]+\s+){0,2}?(packs?|modules?|cells?|systems?)\y', 'gi') loop
    if buyer_interest_format(m[2]) = buyer_interest_format(p_format) then vals := vals || m[1]::numeric; end if;
  end loop;
  if cardinality(vals) = 0 then return null; end if;
  return jsonb_build_object('lo', (select min(v) from unnest(vals) v), 'hi', (select max(v) from unnest(vals) v));
end $$;

create or replace function buyer_interest_product_key(facts jsonb)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  with kwh as (
    select coalesce(buyer_interest_number(facts->'kwh'),
      case when facts->>'kwh_min' is not null and facts->>'kwh_min' = facts->>'kwh_max'
        then buyer_interest_number(facts->'kwh_min') end) as value
  ), part as (
    select 'part:' || buyer_interest_part(part) as key
    from jsonb_array_elements_text(coalesce(facts->'part_numbers', '[]'::jsonb)) part
    where buyer_interest_part(part) is not null
    order by 1 limit 1
  ), model_part as (
    select 'part:' || buyer_interest_part(buyer_interest_model_part_token(facts->>'model')) as key
    where buyer_interest_model_part_token(facts->>'model') is not null
      and buyer_interest_slug(facts->>'cell_maker') is null  -- a cell model (INR21700-50E) is not a part number
  ), wide as (
    select buyer_interest_model_wide_text(facts->>'make', facts->>'model') as model
  ), cellfmt as (
    select case when buyer_interest_format(facts->>'format') = 'cell'
      then buyer_interest_cell_format(facts->>'cell_format') end as value
  )
  select coalesce(
    (select key from part),
    (select key from model_part),
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold(buyer_interest_model_text(facts->>'model')) is not null
        and not buyer_interest_prose_model(facts->>'model')
        and (select value from kwh) is not null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_model_key(facts->>'make', buyer_interest_model_text(facts->>'model')) || '-'
        || buyer_interest_kwh_text((select value from kwh)) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null
        and buyer_interest_slug(facts->>'model') is not null
        and not buyer_interest_prose_model(facts->>'model')
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold((select model from wide)) is not null
        and not buyer_interest_prose_model((select model from wide))
        and (select value from kwh) is null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_model_key(facts->>'make', (select model from wide)) end,
    -- Broad is the last level. A stated make stays on the key, so two makes in one ask keep two lines. With no make the
    -- cell maker stays on it (broad:calb-any-cells), then the cell format, before the chemistry.
    'broad:' || coalesce(buyer_interest_make(facts->>'make') || '-',
        buyer_interest_slug(facts->>'cell_maker') || '-', '')
      || coalesce((select value from cellfmt) || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$function$;

drop function if exists buyer_interest_fact_sets(jsonb, jsonb, jsonb, int, text);
create or replace function buyer_interest_fact_sets(p_spec jsonb, p_context jsonb default '{}'::jsonb,
  p_fields jsonb default '{}'::jsonb, p_limit int default 12, p_title text default null, p_models boolean default false)
returns table (facts jsonb[], stated_total int) language plpgsql stable as $$
declare
  makes text[] := buyer_interest_make_list(buyer_interest_stated_list(p_spec->'makes', buyer_interest_first_text(p_spec->'make'),
    buyer_interest_first_text(p_context->'make'), buyer_interest_first_text(p_fields->'make')));
  chemists text[] := buyer_interest_stated_list(p_spec->'chemistries', buyer_interest_first_text(p_spec->'chemistry'),
    buyer_interest_first_text(p_context->'chemistry'), buyer_interest_first_text(p_fields->'chemistry'));
  formats text[] := buyer_interest_stated_list(p_spec->'formats', buyer_interest_first_text(p_spec->'format'),
    buyer_interest_first_text(p_context->'format'), buyer_interest_first_text(p_fields->'format'));
  cformats text[] := buyer_interest_cell_formats(p_spec, p_context, p_fields);
  cmakers text[] := buyer_interest_stated_list(p_spec->'cell_makers', buyer_interest_first_text(p_spec->'cell_maker'),
    buyer_interest_first_text(p_context->'cell_maker'), buyer_interest_first_text(p_fields->'cell_maker'));
  kwh_text text := concat_ws(' ', p_spec->>'product_family', p_context->>'listing_title', p_title);
  fk jsonb;
  fct jsonb;
  cm text;
  entries text[] := '{}';
  entities jsonb[] := '{}';
  hit record;
  mk text;
  covered boolean;
  model_entities int := 0;
  entity_count int;
  preference text;
  sets jsonb[] := '{}';
  total int := 0;
  cap int := greatest(p_limit, 1);
  ent jsonb;
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

  -- The models the request names: its models list, or a model text that lists models (a separator).
  if p_models then
    if jsonb_typeof(p_spec->'models') = 'array' then
      select coalesce(array_agg(btrim(v)), '{}') into entries from jsonb_array_elements_text(p_spec->'models') v
       where nullif(btrim(v), '') is not null;
    end if;
    if cardinality(entries) = 0 and coalesce(p_spec->>'model', '') ~ '[,;/&]|\yand\y' then
      entries := array[btrim(p_spec->>'model')];
    end if;
    if cardinality(entries) > 0 then
      for hit in
        select distinct h.own, h.make_display, h.slug, h.name, h.kwh
          from unnest(entries) e, lateral buyer_interest_text_models(e, array_remove(makes, null), cardinality(array_remove(makes, null)) = 0) h
         order by h.make_display, h.slug, h.kwh nulls first
      loop
        entities := entities || (jsonb_build_object('makes', jsonb_build_array(hit.make_display), 'make', hit.make_display,
          'model', hit.name, 'own', hit.own, 'slug', hit.slug)
          || case when hit.kwh is null then '{}'::jsonb
               else jsonb_build_object('kwh', hit.kwh, 'kwh_min', hit.kwh, 'kwh_max', hit.kwh) end);
      end loop;
    end if;
  end if;

  if cardinality(entities) > 0 then
    -- Makes the request names without any model keep their make-level set.
    select count(distinct e->>'own' || '/' || (e->>'slug')) into model_entities from unnest(entities) e;
    foreach mk in array array_remove(makes, null) loop
      -- "VW Group" is covered by a model of any make of the group.
      select exists (select 1 from unnest(entities) e, regexp_split_to_table(mk, '\s+or\s+', 'i') piece
                      where e->>'own' = buyer_interest_alias_make_fold(piece)
                         or (buyer_interest_make(piece) = 'vw-group'
                             and e->>'own' in ('volkswagen', 'audi', 'skoda', 'seat', 'cupra', 'porsche'))) into covered;
      if not covered then
        -- A make-level set states no model: the request's model list text must not ride along as its model.
        entities := entities || jsonb_build_object('makes', jsonb_build_array(mk), 'make', mk, 'no_model', true);
      end if;
    end loop;
    -- A model line per kWh still counts as the one model it is.
    entity_count := model_entities + (select count(*) from unnest(entities) e where not (e ? 'slug'));
    cap := greatest(p_limit, 60);
  else
    foreach mk in array makes loop
      entities := entities || jsonb_build_object('makes', case when mk is null then '[]'::jsonb else jsonb_build_array(mk) end,
        'make', mk);
    end loop;
    entity_count := cardinality(array_remove(makes, null));
  end if;

  -- Several cell makers (and no make) are not paired with a chemistry either.
  if cardinality(array_remove(makes, null)) = 0 and cardinality(array_remove(cmakers, null)) >= 2 then
    entity_count := greatest(entity_count, cardinality(array_remove(cmakers, null)));
  end if;

  -- Chemistries are a preference, not a pairing, when several makes or models state several of them.
  if cardinality(array_remove(chemists, null)) >= 2 and entity_count >= 2 then
    preference := array_to_string(array_remove(chemists, null), ' / ');
    chemists := array[null]::text[];
  end if;

  for ent, c, f, cf, cm in
    select e.value, y.value, z.value, w.value, v.value
    from unnest(entities) with ordinality e(value, ord)
    cross join unnest(chemists) y(value)
    cross join unnest(formats) z(value)
    cross join unnest(cformats) w(value)
    -- A line with no make carries each cell maker the request names (broad:calb-any-cells, broad:eve-any-modules).
    cross join lateral unnest(case when e.value->>'make' is null then cmakers else array[null]::text[] end) v(value)
    order by e.ord, 5 nulls first, 2 nulls first, 3 nulls first, 4 nulls first
  loop
    total := total + 1;
    continue when total > cap;
    fct := (buyer_interest_facts(
      case when ent ? 'no_model' then p_spec - 'model' - 'models' else p_spec end
        || case when cm is null then '{}'::jsonb else jsonb_build_object('cell_makers', jsonb_build_array(cm)) end
        || (ent - 'own' - 'slug' - 'no_model') || jsonb_build_object(
        'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
        'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f),
      case when ent ? 'no_model' then p_context - 'model' else p_context end, p_fields - case when ent ? 'no_model' then 'model' else '' end)
      || case when cf is null then '{}'::jsonb else jsonb_build_object('cell_format', cf) end
      || case when preference is null then '{}'::jsonb else jsonb_build_object('chemistry_preference', preference) end);
    -- "LFP prismatic 100Ah cells / 50kWh packs": a capacity the text states for a format rides on that format's line.
    if f is not null and not (ent ? 'slug') and nullif(fct->>'kwh_min', '') is null then
      fk := buyer_interest_format_kwh(kwh_text, f);
      if fk is not null then
        fct := fct || jsonb_build_object('kwh_min', fk->'lo', 'kwh_max', fk->'hi')
          || case when fk->>'lo' = fk->>'hi' then jsonb_build_object('kwh', fk->'lo') else '{}'::jsonb end;
      end if;
    end if;
    sets := sets || fct;
  end loop;
  stated_total := total;
  facts := sets;
  return next;
end $$;

commit;
