-- A request that says "any" keeps the broad Want (follows 130, which stays as applied).
--
-- Serkont's request text says "Kokam KCL255103EN1 103Ah pouch cells; ... open to any NMC cells of 43-110Ah". Migration
-- 130 read Kokam and pouch from the text and narrowed the line to broad:kokam-pouch-nmc-cells, so the buyer lost the
-- broad NMC cells Want it stated. Rule: when the request text says "any" for the product family (any / open to any /
-- or any / beliebige ... followed by cells, packs, modules or a chemistry or format), the makers, cell makers and cell
-- formats it names are examples, not limits. The sync writes the line the spec states (broad:nmc-cells) and may add the
-- specific line as an extra; it never writes only the specific one.
--   * buyer_interest_text_facts_all(): the facts of 130 (unchanged body).
--   * buyer_interest_text_says_any(text): true when the text says "any" for the product family.
--   * buyer_interest_text_facts(): the facts of 130, except none for a request that says "any".
--   * buyer_interest_sync_demand_row(): adds the specific fact set as an extra line for a request that says "any".
-- A request without "any" (Kokam only) is unchanged. Existing lines are not touched until their request is synced again.
begin;
set local lock_timeout = '3s';

create or replace function buyer_interest_text_says_any(p_text text)
returns boolean language sql immutable as $$
  select coalesce(lower(p_text) ~ ('\y(any|beliebige[rnms]?|jede[rnms]?)\s+'
    || '((nmc|nca|lfp|lto|lmo|li-ion|lithium|pouch|prismatic|cylindrical|[0-9][0-9./-]*\s*(ah|kwh)?)\s+){0,3}'
    || '(cells?|packs?|modules?|zellen|nmc|nca|lfp|lto|lmo|pouch|prismatic|cylindrical)\y'), false);
$$;

create or replace function buyer_interest_text_facts_all(p_spec jsonb, p_context jsonb, p_summary text)
returns jsonb language plpgsql stable as $$
declare
  text_ text := concat_ws(' ', p_summary, p_spec->>'product_family', p_context->>'listing_title');
  low text;
  formats text[] := buyer_interest_stated_list(p_spec->'formats', buyer_interest_first_text(p_spec->'format'),
    buyer_interest_first_text(p_context->'format'));
  makes text[] := buyer_interest_make_list(buyer_interest_stated_list(p_spec->'makes', buyer_interest_first_text(p_spec->'make'),
    buyer_interest_first_text(p_context->'make')));
  cmakers text[] := buyer_interest_stated_list(p_spec->'cell_makers', buyer_interest_first_text(p_spec->'cell_maker'),
    buyer_interest_first_text(p_context->'cell_maker'));
  excluded text := lower(coalesce(p_spec->>'excludes', ''));
  cells boolean;
  found text[];
  families text[];
  maker text;
  hits text[];
  fmt text;
  fmts text[];
  mk text;
  out jsonb := '{}'::jsonb;
begin
  if nullif(btrim(text_), '') is null then return out; end if;
  cells := exists (select 1 from unnest(formats) f where buyer_interest_format(f) = 'cell');

  -- Cell format: only for a request that wants cells and states no cell format.
  if cells and buyer_interest_cell_formats(p_spec, p_context, '{}'::jsonb) = array[null]::text[] then
    low := regexp_replace(lower(text_),
      '\y(no|not|non|without|excluding|excludes?|except|never|rejects?)\s+((?!pouch|prismatic|cylindrical)[a-z0-9/-]+\s+){0,2}(pouch|prismatic|cylindrical)\y',
      ' ', 'g');
    select coalesce(array_agg(distinct t order by t), '{}') into found
      from (select unnest(array['18650', '21700', '26650', '32700', '4680', 'prismatic', 'pouch', 'cylindrical']) t) c
     where low ~ ('(^|[^0-9a-z])' || t || '([^0-9a-z]|$)')
       and excluded !~ ('(^|[^0-9a-z])' || t || '([^0-9a-z]|$)');
    select coalesce(array_agg(distinct case when t in ('prismatic', 'pouch') then t else 'cylindrical' end), '{}') into families
      from unnest(found) t;
    if cardinality(found) > 0 and cardinality(families) < 3 then
      out := out || jsonb_build_object('cell_formats', to_jsonb(found));
    end if;
  end if;

  -- Cell maker: a cells request with no make and no cell maker of its own.
  if cells and makes = array[null]::text[] and cmakers = array[null]::text[] then
    select coalesce(array_agg(m order by m), '{}') into hits
      from unnest(array['Kokam', 'CATL', 'LG', 'Samsung SDI', 'SK On', 'Panasonic', 'BYD', 'EVE', 'CALB', 'Gotion',
                        'Northvolt', 'AESC', 'Svolt', 'Farasis', 'Lishen']) m
     where text_ ~ ('\y' || m || '\y');
    if cardinality(hits) > 0 then out := out || jsonb_build_object('cell_makers', to_jsonb(hits)); end if;
  end if;

  -- A spec that states no product: the text's make and format are the only facts there are.
  if not buyer_interest_states_product(buyer_interest_facts(p_spec, p_context, '{}'::jsonb)) then
    mk := buyer_interest_title_make(text_);
    if mk is not null then out := out || jsonb_build_object('makes', jsonb_build_array(mk)); end if;
    low := lower(text_);
    fmts := array_remove(array[
      case when low ~ '\y(bess|ess|containeri[sz]ed|containers?|systems?)\y' then 'system' end,
      case when low ~ '\ypacks?\y' then 'pack' end,
      case when low ~ '\ymodules?\y' then 'module' end,
      case when low ~ '\ycells?\y' then 'cell' end], null);
    if cardinality(fmts) = 1 then out := out || jsonb_build_object('formats', to_jsonb(fmts)); end if;
  end if;
  return out;
end $$;

create or replace function buyer_interest_text_facts(p_spec jsonb, p_context jsonb, p_summary text)
returns jsonb language sql stable as $$
  select case when buyer_interest_text_says_any(concat_ws(' ', p_summary, p_spec->>'product_family'))
    then '{}'::jsonb else buyer_interest_text_facts_all(p_spec, p_context, p_summary) end;
$$;

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
  extra_facts jsonb;
  extra_sets jsonb[];
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
  from buyer_interest_fact_sets(buyer_interest_text_facts(row_.spec, row_.context, row_.summary) || row_.spec,
    row_.context, '{}'::jsonb, 12, null, true) fs;

  -- "any" in the text: the maker, cell maker and cell format it names are examples. The line above is the broad one;
  -- the specific line (the stated example) is an extra.
  extra_facts := buyer_interest_text_facts_all(row_.spec, row_.context, row_.summary);
  if buyer_interest_text_says_any(concat_ws(' ', row_.summary, row_.spec->>'product_family'))
     and extra_facts <> '{}'::jsonb then
    select coalesce(array_agg(f), '{}') into extra_sets
      from buyer_interest_fact_sets(extra_facts || row_.spec, row_.context, '{}'::jsonb, 12, null, true) fs,
           unnest(fs.facts) f
     where not (f = any(fact_sets));
    fact_sets := fact_sets || extra_sets;
  end if;

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

commit;
