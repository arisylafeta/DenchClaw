-- Buyer interest: one dated line per buyer x product key x kind (approved buyer data foundation, step 1a).
-- Additive and idempotent. Readers are untouched: nothing in the app reads this table yet except the new Wants API.
--
-- BACKFILL: these triggers do not look backwards. Applying this migration leaves every existing demand row and
-- offer unrepresented. Step 1b is required and runs the two sync functions over the existing rows
-- (perform buyer_interest_sync_demand_row(id) / buyer_interest_sync_offer_row(id)), and re-runs the importer
-- path for research_profile companies so their mastered lines exist. Do not switch a reader onto this table
-- before that backfill has run and been checked.
--
-- Ownership decides where the fact lives:
--   mastered  standing / interest / inferred   edited in the Buyer tab's Wants table
--   synced    ask / saved_search / bought / declined   copies of a source row, rebuilt by trigger or importer
--
-- Triggers on crm_bulk_listings (demand rows) and crm_bulk_offers (buyer-side offers on supply listings) keep the
-- synced lines true for every writer (app, Python importers, intake, mail index). A sync failure is recorded in
-- buyer_interest_sync_errors and never breaks the parent write.
--
-- A source row states several makes, chemistries or formats: its lines fan out over every combination (cartesian
-- product), so "Toyota or Lexus, Stellantis; NMC or LFP" keeps all four wants. The product is capped at 12 lines
-- per source and a longer list is recorded as operation 'truncated' in buyer_interest_sync_errors, never dropped
-- silently. Re-syncing a row also deletes the lines it no longer states, so a line never outlives its facts.
--
-- Product keys are the same shape the TypeScript builder (apps/web/lib/match/product-key-for.ts) produces:
--   part:SU001B5189            an OEM part number
--   pack:stellantis-ecmp-50kwh a reviewed pack family (TS builder only; SQL leaves the row broad until filled)
--   model:hyundai-ioniq5-77.4kwh make + model + one kWh figure
--   cell:samsung-sdi-inr21700-50e cell maker + cell model
--   broad:lfp-packs            chemistry + format
--   broad:stellantis-nmc-packs the same bucket scoped to a stated make, used when no more specific key is proven
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists buyer_interest (
  id text primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  person_id text references crm_people(id) on delete set null,
  kind text not null check (kind in ('ask', 'standing', 'interest', 'saved_search', 'inferred', 'bought', 'declined')),
  ownership text not null check (ownership in ('mastered', 'synced')),
  product_key text not null check (length(btrim(product_key)) > 0),
  -- Set when the key was filled by the TS builder; a synced line starts broad or at the level SQL could prove.
  product_key_level text check (product_key_level in ('part', 'pack', 'model', 'cell', 'broad')),
  make text,
  model text,
  format text check (format is null or format in ('pack', 'module', 'cell', 'system')),
  chemistry text,
  kwh_min numeric check (kwh_min is null or kwh_min > 0),
  kwh_max numeric check (kwh_max is null or kwh_max > 0),
  first_seen date not null,
  last_seen date not null,
  quantity numeric check (quantity is null or quantity > 0),
  quantity_unit text,
  quantity_basis text check (quantity_basis is null or quantity_basis in ('stated', 'not_stated')),
  price numeric check (price is null or price >= 0),
  price_currency text check (price_currency is null or price_currency in ('EUR', 'USD', 'GBP')),
  price_unit text check (price_unit is null or price_unit in ('kWh', 'pack', 'cell')),
  price_basis text check (price_basis is null or price_basis in ('paid', 'bid', 'target')),
  source_refs text[] not null default '{}',
  expires_on date,
  demand_id text references crm_bulk_listings(id) on delete cascade,
  offer_id text references crm_bulk_offers(id) on delete cascade,
  saved_search_id text,
  decline_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_interest_dates_check check (last_seen >= first_seen),
  constraint buyer_interest_ownership_kind_check check (
    (kind in ('standing', 'interest', 'inferred') and ownership = 'mastered')
    or (kind in ('ask', 'saved_search', 'bought', 'declined') and ownership = 'synced'))
);

-- One mastered line per buyer x product x kind; mastered repeats merge and move last_seen.
create unique index if not exists buyer_interest_mastered_uidx
  on buyer_interest (company_id, product_key, kind) where ownership = 'mastered';
-- One synced line per source row x product x kind, so re-running a sync is an upsert, never a duplicate.
create unique index if not exists buyer_interest_demand_uidx
  on buyer_interest (kind, demand_id, product_key) where demand_id is not null;
create unique index if not exists buyer_interest_offer_uidx
  on buyer_interest (kind, offer_id, product_key) where offer_id is not null;
create unique index if not exists buyer_interest_saved_search_uidx
  on buyer_interest (kind, saved_search_id, product_key) where saved_search_id is not null;
create index if not exists buyer_interest_company_idx on buyer_interest (company_id);
create index if not exists buyer_interest_product_key_idx on buyer_interest (product_key);
create index if not exists buyer_interest_kind_expiry_idx on buyer_interest (kind, expires_on);

-- A sync that fails must be visible without failing the buyer's own write.
create table if not exists buyer_interest_sync_errors (
  id bigint generated by default as identity primary key,
  source_table text not null,
  source_id text,
  operation text,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists buyer_interest_sync_errors_recent_idx on buyer_interest_sync_errors (created_at desc);

-- New context-note categories: the raw form answer, and what an agent research run concluded.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
  where conrelid = 'crm_company_context_notes'::regclass and conname = 'crm_company_context_notes_category_check';
  if def is not null and position('form_answer' in def) > 0 then
    return;  -- already extended
  end if;
  alter table crm_company_context_notes drop constraint if exists crm_company_context_notes_category_check;
  alter table crm_company_context_notes add constraint crm_company_context_notes_category_check
    check (category in ('ask', 'bid', 'offer_reply', 'project', 'preference', 'trading_style', 'past_deal', 'note',
      'saved_search', 'form_answer', 'research_run'));
end $$;

-- ---------------------------------------------------------------------------
-- Product key helpers (kept in step with the TypeScript builder)
-- ---------------------------------------------------------------------------

-- Latin accents to their plain letters, so "Škoda" and "Skoda" are one make. Mirrors the TS builder's deaccent.
create or replace function buyer_interest_unaccent(value text) returns text language sql immutable as $$
  select translate(lower(coalesce(value, '')), 'àáâãäåāăąçćčďèéêëēėęěìíîïīįñńňòóôõöøōőťùúûüūůűýÿžźżšśł', 'aaaaaaaaacccdeeeeeeeeiiiiiinnnooooooootuuuuuuuyyzzzssl')
$$;

-- Lower case, letters and digits only. Same folding as commercial-stock's fold().
create or replace function buyer_interest_fold(value text) returns text language sql immutable as $$
  select nullif(regexp_replace(buyer_interest_unaccent(value), '[^a-z0-9]+', '', 'g'), '')
$$;

-- Lower case, runs of anything else become one hyphen. Readable in keys and logs.
create or replace function buyer_interest_slug(value text) returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(buyer_interest_unaccent(value), '[^a-z0-9]+', '-', 'g'), '-'), '')
$$;

-- First text of a json value, whether it is a string, a one-element array or a number.
create or replace function buyer_interest_first_text(value jsonb) returns text language sql immutable as $$
  select case
    when value is null then null
    when jsonb_typeof(value) = 'array' then nullif(btrim(value->>0), '')
    when jsonb_typeof(value) = 'string' then nullif(btrim(value#>>'{}'), '')
    when jsonb_typeof(value) = 'number' then value#>>'{}'
    else null end
$$;

create or replace function buyer_interest_number(value jsonb) returns numeric language sql immutable as $$
  select case
    when value is null then null
    when jsonb_typeof(value) = 'number' then (value#>>'{}')::numeric
    when jsonb_typeof(value) = 'array' and jsonb_typeof(value->0) = 'number' then (value->>0)::numeric
    when jsonb_typeof(value) = 'string' and btrim(value#>>'{}') ~ '^[0-9]+(\.[0-9]+)?$' then (value#>>'{}')::numeric
    else null end
$$;

-- kWh as the key writes it: one decimal, never a trailing .0 (77.4 -> "77.4", 77.0 -> "77").
create or replace function buyer_interest_kwh_text(value numeric) returns text language sql immutable as $$
  select nullif(regexp_replace(round(value, 1)::text, '\.0+$', ''), '')
$$;

-- The make as a key segment. Group names keep their own identity ("VW Group"), a brand maps to the display
-- name normalMake uses, and anything else is its own slug. The TS builder mirrors this list.
create or replace function buyer_interest_make(value text) returns text language sql immutable as $$
  select case buyer_interest_fold(value)
    when 'vw' then 'volkswagen' when 'volkswagen' then 'volkswagen' when 'vwag' then 'volkswagen'
    when 'volkwagen' then 'volkswagen'
    when 'mercedes' then 'mercedes-benz' when 'mercedesbenz' then 'mercedes-benz' when 'mb' then 'mercedes-benz'
    when 'citroen' then 'citroen' when 'skoda' then 'skoda'
    when 'vwgroup' then 'vw-group' when 'volkswagengroup' then 'vw-group'
    when 'hyundaiorkia' then 'hyundai-or-kia' when 'bmwormini' then 'bmw-or-mini'
    when 'mgorsaic' then 'mg-or-saic' when 'volvoorpolestar' then 'volvo-or-polestar'
    when 'toyotaorlexus' then 'toyota-or-lexus' when 'jlr' then 'jlr' when 'jaguarlandrover' then 'jlr'
    when 'gm' then 'gm' when 'stellantis' then 'stellantis'
    else buyer_interest_slug(value) end
$$;

create or replace function buyer_interest_chemistry(value text) returns text language sql immutable as $$
  with folded as (select buyer_interest_fold(value) as text)
  select case
    when text is null then null
    when text ~ '(lfp|lifepo|lithiumironphosphate|lithiumferrophosphate)' then 'LFP'
    when text ~ '(nmc|ncm|nickelmanganesecobalt)' then 'NMC'
    when text ~ '(nca|nickelcobaltalumin)' then 'NCA'
    when text ~ '(lto|titanate)' then 'LTO'
    when text ~ '(nimh|nickelmetalhydride)' then 'NiMH'
    when text ~ '(lmo|manganeseoxide)' then 'LMO'
    else null end
  from folded
$$;

create or replace function buyer_interest_format(value text) returns text language sql immutable as $$
  select case
    when buyer_interest_fold(value) in ('pack', 'packs') then 'pack'
    when buyer_interest_fold(value) in ('module', 'modules') then 'module'
    when buyer_interest_fold(value) in ('cell', 'cells') then 'cell'
    when buyer_interest_fold(value) in ('system', 'systems') then 'system'
    else null end
$$;

-- The facts behind a key, from a source row's spec, context and trade fields. Never guesses: missing means missing.
create or replace function buyer_interest_facts(p_spec jsonb, p_context jsonb default '{}'::jsonb, p_fields jsonb default '{}'::jsonb)
returns jsonb language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'make', coalesce(buyer_interest_first_text(p_spec->'makes'), buyer_interest_first_text(p_spec->'make'),
      buyer_interest_first_text(p_context->'make'), buyer_interest_first_text(p_fields->'make')),
    'model', coalesce(buyer_interest_first_text(p_spec->'model'), buyer_interest_first_text(p_context->'model'),
      buyer_interest_first_text(p_fields->'model')),
    'format', coalesce(buyer_interest_first_text(p_spec->'formats'), buyer_interest_first_text(p_spec->'format'),
      buyer_interest_first_text(p_context->'format'), buyer_interest_first_text(p_fields->'format')),
    'chemistry', coalesce(buyer_interest_first_text(p_spec->'chemistries'), buyer_interest_first_text(p_spec->'chemistry'),
      buyer_interest_first_text(p_context->'chemistry'), buyer_interest_first_text(p_fields->'chemistry')),
    'kwh', coalesce(buyer_interest_number(p_spec->'kwh'), buyer_interest_number(p_spec->'capacity_kwh'),
      buyer_interest_number(p_context->'kwh'), buyer_interest_number(p_context->'capacity_kwh'),
      buyer_interest_number(p_fields->'capacity_kwh'), buyer_interest_number(p_fields->'kwh')),
    'kwh_min', coalesce(buyer_interest_number(p_spec->'kwh_min'), buyer_interest_number(p_context->'kwh_min')),
    'kwh_max', coalesce(buyer_interest_number(p_spec->'kwh_max'), buyer_interest_number(p_context->'kwh_max')),
    'cell_maker', coalesce(buyer_interest_first_text(p_spec->'cell_makers'), buyer_interest_first_text(p_spec->'cell_maker'),
      buyer_interest_first_text(p_context->'cell_maker')),
    'part_numbers', case when jsonb_typeof(coalesce(p_spec->'part_numbers', p_spec->'partNumbers', p_context->'part_numbers',
        p_fields->'part_numbers')) = 'array'
      then coalesce(p_spec->'part_numbers', p_spec->'partNumbers', p_context->'part_numbers', p_fields->'part_numbers')
      else null end
  ))
$$;

-- Most specific key the facts prove. pack: family keys are the TS builder's job; SQL stops at model.
create or replace function buyer_interest_product_key(facts jsonb) returns text language sql immutable as $$
  with kwh as (
    select coalesce(buyer_interest_number(facts->'kwh'),
      case when facts->>'kwh_min' is not null and facts->>'kwh_min' = facts->>'kwh_max'
        then buyer_interest_number(facts->'kwh_min') end) as value
  ), part as (
    select 'part:' || replace(upper(regexp_replace(btrim(part), '[^A-Za-z0-9]', '', 'g')), 'O', '0') as key
    from jsonb_array_elements_text(coalesce(facts->'part_numbers', '[]'::jsonb)) part
    where length(regexp_replace(btrim(part), '[^A-Za-z0-9]', '', 'g')) between 5 and 14
    order by 1 limit 1
  )
  select coalesce(
    (select key from part),
    case when buyer_interest_make(facts->>'make') is not null and buyer_interest_fold(facts->>'model') is not null
        and (select value from kwh) is not null
      then 'model:' || buyer_interest_make(facts->>'make') || '-' || buyer_interest_fold(facts->>'model') || '-'
        || buyer_interest_kwh_text((select value from kwh)) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null and buyer_interest_slug(facts->>'model') is not null
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    -- Broad is the last level. A stated make stays on the key, so two makes in one ask keep two lines.
    'broad:' || coalesce(buyer_interest_make(facts->>'make') || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$$;

create or replace function buyer_interest_key_level(key text) returns text language sql immutable as $$
  select case
    when key like 'part:%' then 'part'
    when key like 'pack:%' then 'pack'
    when key like 'model:%' then 'model'
    when key like 'cell:%' then 'cell'
    else 'broad' end
$$;

-- Every value a row states for one fact: the array when it has one, else its single value, else one "not stated"
-- slot. Ordered and de-duplicated so a re-sync writes the same lines every time.
create or replace function buyer_interest_stated_list(p_list jsonb, p_first text, p_second text default null,
  p_third text default null) returns text[] language sql immutable as $$
  select coalesce(
    (select array_agg(distinct btrim(value) order by btrim(value))
       from jsonb_array_elements_text(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) value
      where nullif(btrim(value), '') is not null),
    (select array_agg(distinct btrim(value) order by btrim(value))
       from unnest(array[p_first, p_second, p_third]) value
      where nullif(btrim(value), '') is not null),
    array[null]::text[])
$$;

-- One fact set per stated make x chemistry x format, so every combination of a row's facts becomes a line instead
-- of only the first value of each list. Capped at p_limit lines; stated_total says how many the row really states.
create or replace function buyer_interest_fact_sets(p_spec jsonb, p_context jsonb default '{}'::jsonb,
  p_fields jsonb default '{}'::jsonb, p_limit int default 12)
returns table (facts jsonb[], stated_total int) language plpgsql immutable as $$
declare
  makes text[] := buyer_interest_stated_list(p_spec->'makes', buyer_interest_first_text(p_spec->'make'),
    buyer_interest_first_text(p_context->'make'), buyer_interest_first_text(p_fields->'make'));
  chemists text[] := buyer_interest_stated_list(p_spec->'chemistries', buyer_interest_first_text(p_spec->'chemistry'),
    buyer_interest_first_text(p_context->'chemistry'), buyer_interest_first_text(p_fields->'chemistry'));
  formats text[] := buyer_interest_stated_list(p_spec->'formats', buyer_interest_first_text(p_spec->'format'),
    buyer_interest_first_text(p_context->'format'), buyer_interest_first_text(p_fields->'format'));
  sets jsonb[] := '{}';
  m text;
  c text;
  f text;
begin
  for m, c, f in
    select x.value, y.value, z.value
    from unnest(makes) x(value)
    cross join unnest(chemists) y(value)
    cross join unnest(formats) z(value)
    order by 1 nulls first, 2 nulls first, 3 nulls first
    limit greatest(p_limit, 1)
  loop
    sets := sets || buyer_interest_facts(
      p_spec || jsonb_build_object(
        'makes', case when m is null then '[]'::jsonb else jsonb_build_array(m) end, 'make', m,
        'chemistries', case when c is null then '[]'::jsonb else jsonb_build_array(c) end, 'chemistry', c,
        'formats', case when f is null then '[]'::jsonb else jsonb_build_array(f) end, 'format', f),
      p_context, p_fields);
  end loop;
  stated_total := cardinality(makes) * cardinality(chemists) * cardinality(formats);
  facts := sets;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Demand rows -> ask / bought / declined lines
-- ---------------------------------------------------------------------------

create or replace function buyer_interest_sync_demand_row(p_id text) returns void language plpgsql as $$
declare
  row_ crm_bulk_listings%rowtype;
  fact_sets jsonb[];
  stated_total int;
  facts jsonb;
  keys text[] := '{}';
  line_kind text;
  line_reason text;
  first_d date;
  last_d date;
  qty numeric;
  unit text;
  price_v numeric;
  currency_v text;
  price_unit_v text;
  price_basis_v text;
  needed date;
  expiry date;
  expiry_sticky boolean := false;
  refs text[];
begin
  select * into row_ from crm_bulk_listings where id = p_id and kind = 'demand';
  if row_.id is null then
    -- Deleted, or no longer a demand row: its lines no longer describe a buyer's wish.
    delete from buyer_interest where demand_id = p_id;
    return;
  end if;

  -- A buyer we cannot name a company for cannot hold a line; the api resolves the company on write.
  if row_.company_id is null then
    delete from buyer_interest where demand_id = row_.id;
    return;
  end if;

  first_d := coalesce(row_.observed_on, row_.created_at::date, current_date);
  last_d := greatest(coalesce(buyer_interest_first_text(row_.spec->'confirmed_on')::date, first_d), first_d);

  qty := buyer_interest_number(row_.spec->'volume');
  unit := nullif(btrim(coalesce(row_.spec->>'volume_unit', '')), '');
  price_v := buyer_interest_number(row_.spec->'max_price');
  currency_v := nullif(btrim(coalesce(row_.spec->>'price_currency', '')), '');
  price_unit_v := nullif(btrim(coalesce(row_.spec->>'price_unit', '')), '');
  price_basis_v := case when price_v is null then null else 'target' end;
  needed := case when coalesce(row_.spec->>'needed_by', '') ~ '^\d{4}-\d{2}-\d{2}$'
    then (row_.spec->>'needed_by')::date end;
  refs := array_remove(array[row_.source_id, 'crm:' || row_.id]::text[], null);

  if row_.status in ('open', 'qualifying') then
    line_kind := 'ask';
    expiry := needed;
  elsif row_.status = 'closed' and row_.closed_reason = 'expired' then
    -- An expired ask stays visible as history with its expiry; the stale-line delete below drops an older
    -- bought/declined outcome, so a re-staged ask never keeps a superseded decision.
    line_kind := 'ask';
    expiry := coalesce(needed, current_date);
    expiry_sticky := true;  -- the day it lapsed, not the day a later edit touched the row
  elsif row_.status = 'closed' and row_.closed_reason in ('bought_from_us', 'bought_elsewhere', 'no_longer_needed') then
    line_kind := case when row_.closed_reason = 'bought_from_us' then 'bought' else 'declined' end;
    line_reason := case when line_kind = 'declined' then row_.closed_reason end;
    expiry := null;
  else
    -- Not a buying fact (duplicate, moved to profile, converted to supply/trade, research row): drop the asks.
    delete from buyer_interest where demand_id = row_.id;
    return;
  end if;

  select fs.facts, fs.stated_total into fact_sets, stated_total
  from buyer_interest_fact_sets(row_.spec, row_.context) fs;

  -- The key set this row states now. Anything else on this source is stale: an old chemistry, a dropped make,
  -- or an outcome the row has since superseded.
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(fact_sets) fact;
  delete from buyer_interest
  where demand_id = row_.id and not (kind = line_kind and product_key = any(keys));

  foreach facts in array fact_sets loop
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit, quantity_basis,
      price, price_currency, price_unit, price_basis, source_refs, expires_on, demand_id, decline_reason)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), row_.company_id, row_.person_id, line_kind, 'synced',
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
      facts->>'make', facts->>'model', buyer_interest_format(facts->>'format'),
      buyer_interest_chemistry(facts->>'chemistry'), buyer_interest_number(facts->'kwh_min'),
      buyer_interest_number(facts->'kwh_max'), first_d, last_d, qty, unit,
      case when qty is null then 'not_stated' else 'stated' end,
      price_v, currency_v, price_unit_v, price_basis_v, refs, expiry, row_.id, line_reason)
    on conflict (kind, demand_id, product_key) where demand_id is not null do update set
      company_id = excluded.company_id,
      person_id = coalesce(excluded.person_id, buyer_interest.person_id),
      product_key_level = excluded.product_key_level,
      make = coalesce(excluded.make, buyer_interest.make),
      model = coalesce(excluded.model, buyer_interest.model),
      format = coalesce(excluded.format, buyer_interest.format),
      chemistry = coalesce(excluded.chemistry, buyer_interest.chemistry),
      kwh_min = coalesce(excluded.kwh_min, buyer_interest.kwh_min),
      kwh_max = coalesce(excluded.kwh_max, buyer_interest.kwh_max),
      first_seen = least(buyer_interest.first_seen, excluded.first_seen),
      last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
      quantity = coalesce(excluded.quantity, buyer_interest.quantity),
      quantity_unit = coalesce(excluded.quantity_unit, buyer_interest.quantity_unit),
      quantity_basis = coalesce(excluded.quantity_basis, buyer_interest.quantity_basis),
      price = coalesce(excluded.price, buyer_interest.price),
      price_currency = coalesce(excluded.price_currency, buyer_interest.price_currency),
      price_unit = coalesce(excluded.price_unit, buyer_interest.price_unit),
      price_basis = coalesce(excluded.price_basis, buyer_interest.price_basis),
      source_refs = (select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
      expires_on = case when expiry_sticky then coalesce(buyer_interest.expires_on, excluded.expires_on)
        else excluded.expires_on end,
      decline_reason = coalesce(excluded.decline_reason, buyer_interest.decline_reason),
      updated_at = now();
  end loop;

  if stated_total > cardinality(fact_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_listings', row_.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(fact_sets), stated_total));
  end if;
end $$;

create or replace function buyer_interest_sync_demand() returns trigger language plpgsql as $$
begin
  begin
    perform buyer_interest_sync_demand_row(new.id);
  exception when others then
    -- The buyer's write must succeed even when the interest sync cannot.
    begin
      insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
      values ('crm_bulk_listings', new.id, TG_OP, sqlerrm);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- Fires for a demand row, and for a row that stops being one (its lines are then removed). A supply row's own
-- edits never call it. Postgres refuses OLD in an INSERT trigger's WHEN, so insert and update are separate.
drop trigger if exists buyer_interest_demand_sync on crm_bulk_listings;
drop trigger if exists buyer_interest_demand_sync_insert on crm_bulk_listings;
drop trigger if exists buyer_interest_demand_sync_update on crm_bulk_listings;
create trigger buyer_interest_demand_sync_insert after insert on crm_bulk_listings
  for each row when (new.kind = 'demand') execute function buyer_interest_sync_demand();
create trigger buyer_interest_demand_sync_update after update on crm_bulk_listings
  for each row when (old.kind = 'demand' or new.kind = 'demand')
  execute function buyer_interest_sync_demand();

-- A demand row can be written through the crm_bulk_demand view; that view writes the table, so the trigger above sees it.

-- ---------------------------------------------------------------------------
-- Buyer-side offers on supply listings -> bought / declined lines
-- ---------------------------------------------------------------------------

create or replace function buyer_interest_sync_offer_row(p_id text) returns void language plpgsql as $$
declare
  offer crm_bulk_offers%rowtype;
  listing crm_bulk_listings%rowtype;
  fields jsonb;
  fact_sets jsonb[];
  stated_total int;
  facts jsonb;
  keys text[] := '{}';
  line_kind text;
  line_reason text;
  first_d date;
  last_d date;
  qty numeric;
  unit text;
  price_v numeric;
  currency_v text;
  price_unit_v text;
  price_basis_v text;
  refs text[];
begin
  select * into offer from crm_bulk_offers where id = p_id;
  if offer.id is null then
    delete from buyer_interest where offer_id = p_id;
    return;
  end if;

  -- Only a counterparty (a buyer) on a supply listing describes a purchase. Our own contacts do not.
  select * into listing from crm_bulk_listings where id = offer.bulk_listing_id;
  if coalesce(offer.role, '') <> 'counterparty' or offer.company_id is null or listing.id is null
      or listing.kind <> 'supply' then
    delete from buyer_interest where offer_id = offer.id;
    return;
  end if;

  -- Signed is a committed purchase, so it counts as bought; contract_out alone does not.
  if offer.stage in ('signed', 'invoiced', 'paid', 'complete') then
    line_kind := 'bought';
  elsif offer.stage in ('declined', 'lost') then
    line_kind := 'declined';
    line_reason := nullif(btrim(coalesce(offer.declined_reason, '')), '');
  else
    delete from buyer_interest where offer_id = offer.id;  -- no committed purchase: no line
    return;
  end if;

  select coalesce(jsonb_object_agg(lower(field_key), value), '{}'::jsonb) into fields
  from crm_bulk_listing_fields where bulk_listing_id = listing.id and value is not null and status <> 'conflict';

  select fs.facts, fs.stated_total into fact_sets, stated_total
  from buyer_interest_fact_sets(listing.spec, listing.context, fields) fs;

  -- The product the listing states now; a line for another product or outcome on this offer is stale.
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(fact_sets) fact;
  delete from buyer_interest
  where offer_id = offer.id and not (kind = line_kind and product_key = any(keys));

  first_d := coalesce(listing.observed_on, offer.created_at::date, current_date);
  last_d := greatest(coalesce(offer.last_touch_on, offer.updated_at::date, current_date), first_d);
  -- "40 packs" on the listing is the closest the row states; the offer's terms carry the money.
  qty := case when coalesce(listing.quantity, '') ~ '^\s*[0-9]+(\.[0-9]+)?'
    then (regexp_match(listing.quantity, '^\s*([0-9]+(?:\.[0-9]+)?)'))[1]::numeric end;
  unit := nullif(btrim(coalesce(listing.spec->>'volume_unit', '')), '');
  price_v := buyer_interest_number(offer.terms->'amount');
  currency_v := nullif(btrim(coalesce(offer.terms->>'currency', '')), '');
  price_unit_v := case when btrim(coalesce(offer.terms->>'unit', '')) in ('kWh', 'pack', 'cell')
    then btrim(offer.terms->>'unit') end;
  price_basis_v := case when price_v is null then null when line_kind = 'bought' then 'paid' else 'bid' end;
  refs := array_remove(array['crm:' || offer.id, 'crm:' || listing.id]::text[]
    || case when offer.counterpart_id is not null then array['crm:' || offer.counterpart_id]::text[] else '{}'::text[] end,
    null);

  foreach facts in array fact_sets loop
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit, quantity_basis,
      price, price_currency, price_unit, price_basis, source_refs, expires_on, offer_id, decline_reason)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), offer.company_id, offer.person_id, line_kind, 'synced',
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
      facts->>'make', facts->>'model', buyer_interest_format(facts->>'format'),
      buyer_interest_chemistry(facts->>'chemistry'), buyer_interest_number(facts->'kwh_min'),
      buyer_interest_number(facts->'kwh_max'), first_d, last_d, qty, unit,
      case when qty is null then 'not_stated' else 'stated' end,
      price_v, currency_v, price_unit_v, price_basis_v, refs, null, offer.id, line_reason)
    on conflict (kind, offer_id, product_key) where offer_id is not null do update set
      company_id = excluded.company_id,
      person_id = coalesce(excluded.person_id, buyer_interest.person_id),
      product_key_level = excluded.product_key_level,
      make = coalesce(excluded.make, buyer_interest.make),
      model = coalesce(excluded.model, buyer_interest.model),
      format = coalesce(excluded.format, buyer_interest.format),
      chemistry = coalesce(excluded.chemistry, buyer_interest.chemistry),
      kwh_min = coalesce(excluded.kwh_min, buyer_interest.kwh_min),
      kwh_max = coalesce(excluded.kwh_max, buyer_interest.kwh_max),
      first_seen = least(buyer_interest.first_seen, excluded.first_seen),
      last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
      quantity = coalesce(excluded.quantity, buyer_interest.quantity),
      price = coalesce(excluded.price, buyer_interest.price),
      price_currency = coalesce(excluded.price_currency, buyer_interest.price_currency),
      price_unit = coalesce(excluded.price_unit, buyer_interest.price_unit),
      price_basis = coalesce(excluded.price_basis, buyer_interest.price_basis),
      source_refs = (select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
      decline_reason = coalesce(excluded.decline_reason, buyer_interest.decline_reason),
      updated_at = now();
  end loop;

  if stated_total > cardinality(fact_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_offers', offer.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(fact_sets), stated_total));
  end if;
end $$;

create or replace function buyer_interest_sync_offer() returns trigger language plpgsql as $$
begin
  begin
    perform buyer_interest_sync_offer_row(new.id);
  exception when others then
    begin
      insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
      values ('crm_bulk_offers', new.id, TG_OP, sqlerrm);
    exception when others then null;
    end;
  end;
  return null;
end $$;

-- Only the fields a line is built from. A note or a touch date change must not re-sync the line. Postgres refuses
-- OLD in an INSERT trigger's WHEN, so insert and update are separate.
drop trigger if exists buyer_interest_offer_sync on crm_bulk_offers;
drop trigger if exists buyer_interest_offer_sync_insert on crm_bulk_offers;
drop trigger if exists buyer_interest_offer_sync_update on crm_bulk_offers;
create trigger buyer_interest_offer_sync_insert after insert on crm_bulk_offers
  for each row execute function buyer_interest_sync_offer();
create trigger buyer_interest_offer_sync_update after update on crm_bulk_offers
  for each row when (new.stage is distinct from old.stage
    or new.role is distinct from old.role
    or new.company_id is distinct from old.company_id
    or new.person_id is distinct from old.person_id
    or new.terms is distinct from old.terms
    or new.bulk_listing_id is distinct from old.bulk_listing_id
    or new.declined_reason is distinct from old.declined_reason
    or new.counterpart_id is distinct from old.counterpart_id)
  execute function buyer_interest_sync_offer();

do $$ begin
  insert into crm_data_migrations (id) values ('112_buyer_interest') on conflict do nothing;
end $$;

commit;
