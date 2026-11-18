-- A real interest closes a request without being an ask: a marketplace request closed 'not_a_fit' (the buyer wants a
-- product, just not one we list) and a buyer's reply to our offer closed 'offer_reply' ("the team has interest in the SK
-- cells"). Until now the demand sync wrote nothing for them. They now write an 'interest' line (a Said want).
--
-- 'interest' is a mastered kind (table constraint), so the line is written with ownership 'mastered' and merges on
-- (company, product key, kind) with the line a person may already have on the Buyer tab: the existing line keeps its
-- facts and only moves last_seen, expires_on (the later one), person and source refs. A merged line keeps the demand_id
-- of the row that created it. Facts come from the row's own spec, as for an ask; observed_on is first_seen; the line
-- expires 180 days after observed_on. not_demand, duplicate, supply, recycling and the other closes still write nothing.
-- Only create or replace of one function: no table lock. Lines already closed are written by re-running the sync
-- (perform buyer_interest_sync_demand_row(id)) over closed not_a_fit / offer_reply rows; that backfill is not part of
-- this migration.
begin;
set local lock_timeout = '3s';

create or replace function buyer_interest_sync_demand_row(p_id text) returns void language plpgsql as $$
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
  elsif row_.status = 'closed' and row_.closed_reason in ('bought_from_us', 'bought_elsewhere', 'no_longer_needed') then
    line_kind := case when row_.closed_reason = 'bought_from_us' then 'bought' else 'declined' end;
    line_reason := case when line_kind = 'declined' then row_.closed_reason end;
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
end $$;

do $$ begin
  insert into crm_data_migrations (id) values ('117_buyer_interest_closed_interest') on conflict do nothing;
end $$;

commit;
