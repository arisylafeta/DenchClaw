-- Wants sync rules (follows 117 and 119, which stay as applied).
--
-- 1. A closed Request never becomes a Decline: closed_reason no_longer_needed or bought_elsewhere writes no Want and
--    drops the request's non-mastered line. bought_from_us stays bought; not_a_fit and offer_reply stay a Said line;
--    expired keeps the ask line as history.
-- 2. A part number written inside the model text ("Toyota Proace SU001B5189") is no part of the model key: it is
--    stripped from the model, and with no explicit part number it becomes the part key (part:SU001B5189).
--    Mirrored in apps/web/lib/match/product-key-for.ts.
-- 3. buyer_interest_suppressed remembers lines a cleanup removed; both sync functions skip writing them.
begin;

-- A part number written inside the model text ("Toyota Proace SU001B5189"). Needs letters and digits, 8+ code
-- characters, and is not a capacity ("1000kWh"). Mirrors modelPartToken() in product-key-for.ts.
create or replace function buyer_interest_model_part_token(value text) returns text language sql immutable as $$
  select min(token)
  from unnest(regexp_split_to_array(btrim(coalesce(value, '')), '\s+')) token
  where buyer_interest_part(token) is not null
    and length(buyer_interest_part(token)) >= 8
    and token ~ '[A-Za-z]' and token ~ '[0-9]'
    and token !~* '(kwh|ah)$'
$$;

create or replace function buyer_interest_strip_model_part(value text) returns text language sql immutable as $$
  select nullif(btrim(coalesce(string_agg(token, ' ' order by ord), '')), '')
  from unnest(regexp_split_to_array(btrim(coalesce(value, '')), '\s+')) with ordinality t(token, ord)
  where token is distinct from buyer_interest_model_part_token(value)
$$;

create or replace function buyer_interest_model_text(value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select nullif(btrim(regexp_replace(regexp_replace(buyer_interest_strip_model_part(btrim(coalesce(value, ''))), '\y[0-9]+(\.[0-9]+)?\s*kwh\y', ' ', 'gi'), '\s+', ' ', 'g')), '')
$function$;

create or replace function buyer_interest_model_wide_text(p_make text, p_model text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  with step as (
    select btrim(regexp_replace(regexp_replace(btrim(coalesce(buyer_interest_strip_model_part(p_model), '')),
             '\y[0-9]+(\.[0-9]+)?\s*kwh\y', ' ', 'gi'),
             '\y(hv\s+)?(battery|batteries|packs?|modules?)\y', ' ', 'gi')) as text
  ), squashed as (
    select btrim(regexp_replace(text, '\s+', ' ', 'g')) as text from step
  )
  select nullif(btrim(case
    when btrim(coalesce(p_make, '')) <> '' and lower(text) like lower(btrim(p_make)) || ' %'
      then substr(text, length(btrim(p_make)) + 2)
    else text end), '')
  from squashed
$function$;

create or replace function buyer_interest_product_key(facts jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
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
$function$;


-- Removed-line memory: a sync never writes a line for a (company, kind, product key) listed here.
create table if not exists buyer_interest_suppressed (
  company_id text not null,
  kind text not null,
  product_key text not null,
  source_ref text,
  reason text,
  created_at timestamptz not null default now(),
  primary key (company_id, kind, product_key)
);

do $seed$
begin
  if to_regclass('buyer_interest_removed_20261115') is not null then
    insert into buyer_interest_suppressed (company_id, kind, product_key, source_ref, reason)
    select distinct on (company_id, kind, product_key) company_id, kind, product_key,
      'crm:' || coalesce(demand_id, offer_id), 'removed in cleanup 2026-11-15'
    from buyer_interest_removed_20261115
    where kind in ('ask', 'declined', 'bought', 'interest') and (demand_id is not null or offer_id is not null)
    on conflict do nothing;
  end if;
  if to_regclass('buyer_interest_removed_20261118') is not null then
    insert into buyer_interest_suppressed (company_id, kind, product_key, source_ref, reason)
    select distinct on (company_id, kind, product_key) company_id, kind, product_key,
      'crm:' || coalesce(demand_id, offer_id), 'removed in cleanup 2026-11-18'
    from buyer_interest_removed_20261118
    where kind in ('ask', 'declined', 'bought', 'interest') and (demand_id is not null or offer_id is not null)
    on conflict do nothing;
  end if;
  if to_regclass('buyer_interest_pre_cleanup_20261117') is not null then
    insert into buyer_interest_suppressed (company_id, kind, product_key, source_ref, reason)
    select distinct on (p.company_id, p.kind, p.product_key) p.company_id, p.kind, p.product_key,
      'crm:' || coalesce(p.demand_id, p.offer_id), 'removed in cleanup 2026-11-17'
    from buyer_interest_pre_cleanup_20261117 p
    where p.kind in ('ask', 'declined', 'bought', 'interest') and (p.demand_id is not null or p.offer_id is not null)
      and not exists (select 1 from buyer_interest b
        where b.company_id = p.company_id and b.kind = p.kind and b.product_key = p.product_key)
    on conflict do nothing;
  end if;
end $seed$;

create or replace function buyer_interest_sync_demand_row(p_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  row_ crm_bulk_listings%rowtype;
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
  from buyer_interest_fact_sets(row_.spec, row_.context) fs;

  -- A row that states no product at all is not a want: it is not written, only recorded for a person to fix.
  select coalesce(array_agg(fact), '{}') into product_sets from unnest(fact_sets) fact
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
  select coalesce(array_agg(distinct buyer_interest_product_key(fact)), '{}') into keys
  from unnest(product_sets) fact;

  delete from buyer_interest
  where demand_id = row_.id and not (kind = line_kind and product_key = any(keys));

  foreach facts in array product_sets loop
    if exists (select 1 from buyer_interest_suppressed s where s.company_id = row_.company_id and s.kind = line_kind
        and s.product_key = buyer_interest_product_key(facts)) then
      continue;  -- removed in a cleanup: a re-sync does not bring the line back
    end if;
    if said then
      insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
        make, model, raw_product, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
        quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on, demand_id)
      values ('bi_' || replace(gen_random_uuid()::text, '-', ''), row_.company_id, row_.person_id, 'interest', 'mastered',
        buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
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
      buyer_interest_product_key(facts), buyer_interest_key_level(buyer_interest_product_key(facts)),
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
        and s.product_key = buyer_interest_product_key(facts)) then
      continue;  -- removed in a cleanup: a re-sync does not bring the line back
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
