-- One product, one key (follows 120, 121, 122 and 123, which stay as applied).
--
-- 1. The make segment of a model key is the canonical make: FPT Industrial, Iveco and Iveco FPT are fpt, LG Chem is lg,
--    and Stellantis or PSA with a model of the alias list takes the model's own make (Stellantis 500e is fiat-500e). A
--    group name with an unknown model stays (psa-ek9step).
-- 2. The kWh of a model key snaps to the model's nominal variant within 2 kWh (Niro 64 is 64.8, Model 3 57 is 57.5),
--    else it rounds to one decimal, so a Want and a lot of the same pack produce the same key. Variants, key makes and
--    group makes come from model_aliases.json (scripts/rebattery/model_aliases.py --write regenerates the blocks).
-- 3. buyer_interest_suppressed blocks a removed line only for its own source: both sync functions skip a suppressed key
--    when the row's source (crm:<id>) is the suppressed row's source_ref, or that source_ref is null. A new request for the
--    same product from another source writes its line.
-- This migration does not re-sync existing lines; the backfill is a separate step (existing keys keep their old spelling
-- until their source row is synced again).
begin;
set local lock_timeout = '3s';

-- The key make segment a spelling maps to, from the alias list (folded spelling, e.g. fptindustrial -> fpt).
create or replace function buyer_interest_key_make_alias(p_fold text) returns text language sql immutable as $$
  select case p_fold
    -- BEGIN GENERATED KEY MAKES
    when 'fptindustrial' then 'fpt'
    when 'fptind' then 'fpt'
    when 'iveco' then 'fpt'
    when 'ivecofpt' then 'fpt'
    when 'fptiveco' then 'fpt'
    when 'ivecofptindustrial' then 'fpt'
    when 'lgchem' then 'lg'
    when 'lgenergysolution' then 'lg'
    when 'lgensol' then 'lg'
    when 'lges' then 'lg'
    -- END GENERATED KEY MAKES
    else null end
$$;

-- Makes that are groups, not vehicle makes: the model decides the make.
create or replace function buyer_interest_is_group_make(p_fold text) returns boolean language sql immutable as $$
  select p_fold in (
    -- BEGIN GENERATED GROUP MAKES
    'stellantis', 'psa'
    -- END GENERATED GROUP MAKES
  )
$$;

-- The make segment of a model key (or of a broad key when p_model is null). Mirrors keyMakeFor() in product-key-for.ts.
create or replace function buyer_interest_key_make(p_make text, p_model text) returns text language sql stable as $$
  select coalesce(
    buyer_interest_key_make_alias(buyer_interest_fold(p_make)),
    case when buyer_interest_is_group_make(buyer_interest_fold(p_make)) and nullif(btrim(coalesce(p_model, '')), '') is not null
        and p_model !~ '[,;:]' then
      (select buyer_interest_make(min(a.make_display))
         from buyer_interest_model_alias a
        where buyer_interest_model_norm(p_make, p_model) = a.alias
           or left(buyer_interest_model_norm(p_make, p_model), length(a.alias) + 1) = a.alias || ' '
        having count(distinct a.own) = 1 and bool_and(not buyer_interest_is_group_make(a.own))) end,
    buyer_interest_make(p_make))
$$;

-- The kWh of a model key: the nearest nominal variant of the model within 2 kWh (the lower one on a tie), else one decimal.
create or replace function buyer_interest_snap_kwh(p_make text, p_model text, p_kwh numeric) returns numeric language sql stable as $$
  select coalesce((select v.kwh
                     from (values
    -- BEGIN GENERATED KWH VARIANTS
    ('kia', 'niro', 39.2),
    ('kia', 'niro', 64.8),
    ('hyundai', 'kona', 39.2),
    ('hyundai', 'kona', 64.8),
    ('tesla', 'model3', 50),
    ('tesla', 'model3', 57.5),
    ('tesla', 'model3', 60),
    ('tesla', 'model3', 75),
    ('tesla', 'model3', 78),
    ('tesla', 'model3', 82),
    ('nissan', 'leaf', 24),
    ('nissan', 'leaf', 30),
    ('nissan', 'leaf', 40),
    ('nissan', 'leaf', 62),
    ('renault', 'zoe', 22),
    ('renault', 'zoe', 41),
    ('renault', 'zoe', 52),
    ('volkswagen', 'id3', 45),
    ('volkswagen', 'id3', 58),
    ('volkswagen', 'id3', 77),
    ('volkswagen', 'id4', 52),
    ('volkswagen', 'id4', 77),
    ('hyundai', 'ioniq', 28),
    ('hyundai', 'ioniq', 38.3),
    ('hyundai', 'ioniq5', 58),
    ('hyundai', 'ioniq5', 72.6),
    ('hyundai', 'ioniq5', 77.4),
    ('hyundai', 'ioniq5', 84),
    ('kia', 'ev6', 58),
    ('kia', 'ev6', 77.4),
    ('kia', 'ev6', 84),
    ('fpt', 'ebs37', 36.9),
    ('fpt', 'ebs69', 69.3)
    -- END GENERATED KWH VARIANTS
                     ) v(make, model, kwh)
                    where v.make = p_make and v.model = p_model and abs(v.kwh - p_kwh) <= 2
                    order by abs(v.kwh - p_kwh), v.kwh limit 1),
                  round(p_kwh, 1))
$$;

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
      then 'model:' || buyer_interest_key_make(facts->>'make', buyer_interest_model_text(facts->>'model')) || '-'
        || buyer_interest_model_key(facts->>'make', buyer_interest_model_text(facts->>'model')) || '-'
        || buyer_interest_kwh_text(buyer_interest_snap_kwh(
             buyer_interest_key_make(facts->>'make', buyer_interest_model_text(facts->>'model')),
             buyer_interest_model_key(facts->>'make', buyer_interest_model_text(facts->>'model')),
             (select value from kwh))) || 'kwh' end,
    case when buyer_interest_slug(facts->>'cell_maker') is not null
        and buyer_interest_slug(facts->>'model') is not null
        and not buyer_interest_prose_model(facts->>'model')
      then 'cell:' || buyer_interest_slug(facts->>'cell_maker') || '-' || buyer_interest_slug(facts->>'model') end,
    case when buyer_interest_make(facts->>'make') is not null
        and buyer_interest_fold((select model from wide)) is not null
        and not buyer_interest_prose_model((select model from wide))
        and (select value from kwh) is null
      then 'model:' || buyer_interest_key_make(facts->>'make', (select model from wide)) || '-' || buyer_interest_model_key(facts->>'make', (select model from wide)) end,
    -- Broad is the last level. A stated make stays on the key, so two makes in one ask keep two lines. With no make the
    -- cell maker stays on it (broad:calb-any-cells), then the cell format, before the chemistry.
    'broad:' || coalesce(buyer_interest_key_make(facts->>'make', null) || '-',
        buyer_interest_slug(facts->>'cell_maker') || '-', '')
      || coalesce((select value from cellfmt) || '-', '')
      || coalesce(buyer_interest_slug(buyer_interest_chemistry(facts->>'chemistry')), 'any') || '-'
      || case buyer_interest_format(facts->>'format')
           when 'pack' then 'packs' when 'module' then 'modules' when 'cell' then 'cells' when 'system' then 'systems'
           else 'batteries' end
  )
$function$;

create or replace function buyer_interest_sync_demand_row(p_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  row_ crm_bulk_listings%rowtype;
  fact_sets jsonb[];
  product_sets jsonb[];
  set_keys text[];
  stated_total int;
  facts jsonb;
  set_key text;
  i int;
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
  said boolean := false;
  refs text[];
begin
  -- One writer per source: the trigger and the backfill queue here, and each reads the row after the lock is
  -- granted, so the last one in always writes the newest facts. FOR KEY SHARE re-reads the current row version
  -- without blocking an ordinary UPDATE, so a writer holding the row cannot deadlock with a sync waiting here.
  perform pg_advisory_xact_lock(hashtext('demand:' || p_id));
  select * into row_ from crm_bulk_listings where id = p_id and kind = 'demand' for key share;
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
  elsif row_.status = 'closed' and row_.closed_reason in ('bought_elsewhere', 'no_longer_needed') then
    -- A request that ended without us is not a decline of a product: it writes no Want. Its non-mastered line (an
    -- older ask or outcome) goes, as for any other closure.
    delete from buyer_interest where demand_id = row_.id and ownership <> 'mastered';
    return;
  elsif row_.status = 'closed' and row_.closed_reason = 'bought_from_us' then
    line_kind := 'bought';
    expiry := null;
  elsif row_.status = 'closed' and row_.closed_reason in ('not_a_fit', 'offer_reply') then
    -- The request was not a fit for the marketplace, or it is a buyer's reply to our offer: either way the buyer
    -- said they want this product. That is a 'Said' (interest) line, dated when it was seen, for 180 days. Interest is
    -- a mastered kind, so it merges with the buyer's existing line for the same product instead of duplicating it.
    line_kind := 'interest';
    said := true;
    expiry := first_d + 180;
  else
    -- Not a buying fact (duplicate, moved to profile, converted to supply/trade, research row): drop the asks.
    delete from buyer_interest where demand_id = row_.id;
    return;
  end if;

  select fs.facts, fs.stated_total into fact_sets, stated_total
  from buyer_interest_fact_sets(row_.spec, row_.context, '{}'::jsonb, 12, null, true) fs;

  -- p_models: a request that names several models writes a line per model (and per kWh); see buyer_interest_fact_sets.
  -- A row that states no product at all is not a want: it is not written, only recorded for a person to fix.
  select coalesce(array_agg(fact), '{}'), coalesce(array_agg(buyer_interest_product_key(fact)), '{}')
    into product_sets, set_keys from unnest(fact_sets) fact
   where buyer_interest_states_product(fact);
  delete from buyer_interest_sync_errors where operation = 'no_product_facts' and source_id = row_.id;
  if cardinality(product_sets) = 0 then
    delete from buyer_interest where demand_id = row_.id;
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_listings', row_.id, 'no_product_facts',
      format('states no product fact (make, chemistry, format, part or kWh): %s',
        left(coalesce(nullif(btrim(coalesce(row_.summary, '')), ''), row_.source_id, row_.id), 120)));
    return;
  end if;

  -- The key set this row states now. Anything else on this source is stale: an old chemistry, a dropped make,
  -- or an outcome the row has since superseded.
  select coalesce(array_agg(distinct k), '{}') into keys from unnest(set_keys) k;

  delete from buyer_interest
  where demand_id = row_.id and not (kind = line_kind and product_key = any(keys));

  for i in 1..cardinality(product_sets) loop
    facts := product_sets[i];
    set_key := set_keys[i];
    if exists (select 1 from buyer_interest_suppressed s where s.company_id = row_.company_id and s.kind = line_kind
        and s.product_key = set_key and (s.source_ref is null or s.source_ref in ('crm:' || row_.id, row_.id))) then
      continue;  -- removed in a cleanup from this source: a re-sync does not bring the line back
    end if;
    if said then
      insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
        make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
        quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on, demand_id)
      values ('bi_' || replace(gen_random_uuid()::text, '-', ''), row_.company_id, row_.person_id, 'interest', 'mastered',
        set_key, buyer_interest_key_level(set_key),
        facts->>'make', facts->>'model', buyer_interest_raw_product(facts),
        buyer_interest_format(facts->>'format'),
        buyer_interest_chemistry(facts->>'chemistry'), buyer_interest_number(facts->'kwh_min'),
        buyer_interest_number(facts->'kwh_max'), first_d, last_d, qty, unit,
        case when qty is null then 'not_stated' else 'stated' end,
        price_v, currency_v, price_unit_v, price_basis_v, refs, expiry, row_.id)
      on conflict (company_id, product_key, kind) where ownership = 'mastered' do update set
        person_id = coalesce(excluded.person_id, buyer_interest.person_id),
        first_seen = least(buyer_interest.first_seen, excluded.first_seen),
        last_seen = greatest(buyer_interest.last_seen, excluded.last_seen),
        expires_on = case when buyer_interest.expires_on is null then null
          else greatest(buyer_interest.expires_on, excluded.expires_on) end,
        source_refs = (select array_agg(distinct ref order by ref) from unnest(buyer_interest.source_refs || excluded.source_refs) ref),
        updated_at = now();
      continue;
    end if;
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
      quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on, demand_id,
      decline_reason)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), row_.company_id, row_.person_id, line_kind, 'synced',
      set_key, buyer_interest_key_level(set_key),
      facts->>'make', facts->>'model', buyer_interest_raw_product(facts),
      buyer_interest_format(facts->>'format'),
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
      raw_product = coalesce(excluded.raw_product, buyer_interest.raw_product),
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

  if stated_total > cardinality(product_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_listings', row_.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(product_sets), stated_total));
  end if;
end $function$;

create or replace function buyer_interest_sync_offer_row(p_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  offer crm_bulk_offers%rowtype;
  listing crm_bulk_listings%rowtype;
  fields jsonb;
  fact_sets jsonb[];
  product_sets jsonb[];
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
  -- Same single-writer rule as the demand sync: lock on the offer, then read offer, listing and fields.
  perform pg_advisory_xact_lock(hashtext('offer:' || p_id));
  select * into offer from crm_bulk_offers where id = p_id for key share;
  if offer.id is null then
    delete from buyer_interest where offer_id = p_id;
    return;
  end if;

  -- Only a counterparty (a buyer) on a supply listing describes a purchase. Our own contacts do not.
  select * into listing from crm_bulk_listings where id = offer.bulk_listing_id for key share;
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
  from buyer_interest_fact_sets(listing.spec, listing.context, fields, 12,
    coalesce(nullif(btrim(listing.context->>'listing_title'), ''), nullif(btrim(coalesce(listing.spec->>'listing_title', '')), ''),
      listing.summary)) fs;

  -- A listing that states no product at all gives the purchase nothing to match: it is recorded, not written.
  select coalesce(array_agg(fact), '{}') into product_sets from unnest(fact_sets) fact
   where buyer_interest_states_product(fact);
  delete from buyer_interest_sync_errors where operation = 'no_product_facts' and source_id = offer.id;
  if cardinality(product_sets) = 0 then
    delete from buyer_interest where offer_id = offer.id;
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_offers', offer.id, 'no_product_facts',
      format('listing %s states no product fact (make, chemistry, format, part or kWh): %s', listing.id,
        left(coalesce(nullif(btrim(coalesce(listing.summary, '')), ''), listing.id), 100)));
    return;
  end if;

  -- The product the listing states now; a line for another product or outcome on this offer is stale.
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(product_sets) fact;
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

  foreach facts in array product_sets loop
    if exists (select 1 from buyer_interest_suppressed s where s.company_id = offer.company_id and s.kind = line_kind
        and s.product_key = buyer_interest_product_key(facts)
        and (s.source_ref is null or s.source_ref in ('crm:' || offer.id, offer.id))) then
      continue;  -- removed in a cleanup from this source: a re-sync does not bring the line back
    end if;
    insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
      make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
      quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on, offer_id,
      decline_reason)
    values ('bi_' || replace(gen_random_uuid()::text, '-', ''), offer.company_id, offer.person_id, line_kind, 'synced',
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
      facts->>'make', facts->>'model', buyer_interest_raw_product(facts),
      buyer_interest_format(facts->>'format'),
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
      raw_product = coalesce(excluded.raw_product, buyer_interest.raw_product),
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

  if stated_total > cardinality(product_sets) then
    insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
    values ('crm_bulk_offers', offer.id, 'truncated',
      format('kept %s of %s stated combinations', cardinality(product_sets), stated_total));
  end if;
end $function$;

commit;
