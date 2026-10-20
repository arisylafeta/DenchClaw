-- Name the bulk-trade listings "bulk listings" so they are never confused with marketplace listings in the platform
-- (Supabase) database. Renames only; no data changes except one spec key on trade rows (see the end).
--   crm_trade_listings -> crm_bulk_listings,  crm_trade_listing_activity -> crm_bulk_listing_activity,
--   crm_trade_listing_fields/files -> crm_bulk_listing_fields/files,  crm_trade_offers -> crm_bulk_offers,
--   column listing_id -> bulk_listing_id on activity, offers, fields and files.
-- Apply only after a current backup and explicit schema approval.
begin;

alter table crm_trade_listings rename to crm_bulk_listings;
alter table crm_trade_listing_activity rename to crm_bulk_listing_activity;
alter table crm_trade_listing_fields rename to crm_bulk_listing_fields;
alter table crm_trade_listing_files rename to crm_bulk_listing_files;
alter table crm_trade_offers rename to crm_bulk_offers;
alter table crm_bulk_listing_activity rename column listing_id to bulk_listing_id;
alter table crm_bulk_offers rename column listing_id to bulk_listing_id;
alter table crm_bulk_listing_fields rename column listing_id to bulk_listing_id;
alter table crm_bulk_listing_files rename column listing_id to bulk_listing_id;
alter sequence crm_trade_listing_activity_id_seq rename to crm_bulk_listing_activity_id_seq;

-- Constraint and index names follow their tables.
do $$ declare r record; begin
  for r in select c.conrelid::regclass::text as tbl, c.conname from pg_constraint c
           where c.conname like 'crm\_trade\_%' and c.conrelid::regclass::text like 'crm\_bulk\_%' loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, regexp_replace(r.conname, '^crm_trade_', 'crm_bulk_'));
  end loop;
  for r in select i.indexname from pg_indexes i where i.schemaname = 'public' and i.indexname like 'crm\_trade\_%'
           and not exists (select 1 from pg_constraint c where c.conname = i.indexname) loop
    execute format('alter index %I rename to %I', r.indexname, regexp_replace(r.indexname, '^crm_trade_', 'crm_bulk_'));
  end loop;
end $$;

alter function trade_listing_demand_keys(jsonb) rename to bulk_listing_demand_keys;
alter function trade_listing_demand_rest(jsonb) rename to bulk_listing_demand_rest;

-- Triggers and functions: recreate under the new names (function bodies name the tables).
drop trigger trade_listing_qualification_clock on crm_bulk_listings;
drop trigger trade_listing_status_activity on crm_bulk_listings;
drop trigger crm_bulk_trade_demand_write on crm_bulk_trade_demand;
drop trigger crm_bulk_trade_supply_write on crm_bulk_trade_supply;
drop trigger crm_bulk_trade_demand_activity_write on crm_bulk_trade_demand_activity;



CREATE OR REPLACE FUNCTION public.bulk_listing_qualification_clock()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare today text := ((now() at time zone 'Europe/London')::date)::text;
begin
  if new.kind = 'demand' and new.status = 'qualifying' then
    if TG_OP = 'INSERT' then
      if new.spec->>'qualify_entered_on' is null then new.spec := new.spec || jsonb_build_object('qualify_entered_on', today); end if;
    elsif old.status is distinct from new.status then
      new.spec := (new.spec - 'qualify_asked_on') || jsonb_build_object('qualify_entered_on', today);
    end if;
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.bulk_listing_status_activity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', initcap(new.status), jsonb_build_object('status', new.status));
  elsif old.status is distinct from new.status then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', case when new.status = 'closed' then 'Closed · ' || coalesce(new.closed_reason, 'closed')
      when new.status = 'open' then 'Opened' else 'Qualifying' end,
      jsonb_build_object('from', old.status, 'status', new.status, 'reason', new.closed_reason));
  elsif new.status = 'closed' and old.closed_reason is distinct from new.closed_reason then
    insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
    values (new.id, 'status', 'Category · ' || new.closed_reason,
      jsonb_build_object('from_reason', old.closed_reason, 'reason', new.closed_reason, 'status', new.status));
  end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.bulk_demand_view_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare moved jsonb; begin
  if TG_OP = 'DELETE' then delete from crm_bulk_listings where id = OLD.id and kind = 'demand'; return OLD; end if;
  moved := jsonb_strip_nulls(jsonb_build_object('intent', coalesce(NEW.kind, 'standing'),
    'basis', case when coalesce(NEW.kind, 'standing') = 'standing' then coalesce(NEW.basis, 'stated') else NEW.basis end,
    'needed_by', NEW.needed_by, 'volume', NEW.volume, 'volume_unit', NEW.volume_unit, 'max_price', NEW.max_price,
    'price_currency', NEW.price_currency, 'price_unit', NEW.price_unit, 'price_basis', NEW.price_basis, 'fee_eur', NEW.fee_eur,
    'reputation', NEW.reputation, 'qualify_question', NEW.qualify_question, 'qualify_asked_on', NEW.qualify_asked_on,
    'qualify_entered_on', NEW.qualify_entered_on, 'product_family', NEW.product_family, 'confirmed_on', NEW.confirmed_on,
    'supply_match_hash', NEW.supply_match_hash, 'priority', case when NEW.priority then true end));
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listings (id, kind, party, company_id, person_id, contact, email, summary, quantity, location, note, status,
      closed_reason, observed_on, source_kind, source_id, source_thread, source_label, source_url, source_quote, match_hash, spec, context,
      created_at, updated_at)
    values (NEW.id, 'demand', NEW.buyer, NEW.company_id, NEW.person_id, NEW.contact, NEW.email, NEW.wants, NEW.quantity, NEW.location, NEW.note,
      coalesce(NEW.status, 'open'), NEW.closed_reason, NEW.observed_on, NEW.source_kind, NEW.source_id, NEW.source_thread, NEW.source_label,
      NEW.source_url, NEW.source_quote, NEW.match_hash, coalesce(NEW.spec, '{}'::jsonb) || moved, coalesce(NEW.context, '{}'::jsonb),
      coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()))
    on conflict (id) do nothing;  -- lets 'insert ... on conflict do nothing' through the view behave as before
    return NEW;
  end if;
  update crm_bulk_listings set id = NEW.id, party = NEW.buyer, company_id = NEW.company_id, person_id = NEW.person_id, contact = NEW.contact,
    email = NEW.email, summary = NEW.wants, quantity = NEW.quantity, location = NEW.location, note = NEW.note, status = NEW.status,
    closed_reason = NEW.closed_reason, observed_on = NEW.observed_on, source_kind = NEW.source_kind, source_id = NEW.source_id,
    source_thread = NEW.source_thread, source_label = NEW.source_label, source_url = NEW.source_url, source_quote = NEW.source_quote,
    match_hash = NEW.match_hash, spec = coalesce(NEW.spec, '{}'::jsonb) || moved, context = coalesce(NEW.context, '{}'::jsonb),
    created_at = NEW.created_at, updated_at = NEW.updated_at
  where id = OLD.id and kind = 'demand';
  return NEW;
end $function$;

CREATE OR REPLACE FUNCTION public.bulk_supply_view_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare moved jsonb; begin
  if TG_OP = 'DELETE' then delete from crm_bulk_listings where id = OLD.id and kind = 'supply' and not (spec ? 'is_trade'); return OLD; end if;
  moved := jsonb_strip_nulls(jsonb_build_object('trade_kind', NEW.trade_kind, 'est_tonnes', NEW.est_tonnes, 'size_note', NEW.size_note));
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listings (id, kind, party, company_id, person_id, contact, email, summary, quantity, location, status, closed_reason,
      observed_on, source_kind, source_id, source_thread, source_label, source_url, source_quote, match_hash, spec, created_at, updated_at)
    values (NEW.id, 'supply', NEW.seller, NEW.company_id, NEW.person_id, NEW.contact, NEW.email, NEW.offers, NEW.quantity, NEW.location,
      coalesce(NEW.status, 'open'), NEW.closed_reason, NEW.observed_on, NEW.source_kind, NEW.source_id, NEW.source_thread, NEW.source_label,
      NEW.source_url, NEW.source_quote, NEW.match_hash, moved, coalesce(NEW.created_at, now()), coalesce(NEW.updated_at, now()))
    on conflict (id) do nothing;  -- lets 'insert ... on conflict do nothing' through the view behave as before
    return NEW;
  end if;
  update crm_bulk_listings set id = NEW.id, party = NEW.seller, company_id = NEW.company_id, person_id = NEW.person_id, contact = NEW.contact,
    email = NEW.email, summary = NEW.offers, quantity = NEW.quantity, location = NEW.location, status = NEW.status,
    closed_reason = NEW.closed_reason, observed_on = NEW.observed_on, source_kind = NEW.source_kind, source_id = NEW.source_id,
    source_thread = NEW.source_thread, source_label = NEW.source_label, source_url = NEW.source_url, source_quote = NEW.source_quote,
    match_hash = NEW.match_hash, spec = (spec - 'trade_kind' - 'est_tonnes' - 'size_note') || moved,
    created_at = NEW.created_at, updated_at = NEW.updated_at
  where id = OLD.id and kind = 'supply' and not (spec ? 'is_trade');
  return NEW;
end $function$;

CREATE OR REPLACE FUNCTION public.bulk_demand_activity_view_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if TG_OP = 'DELETE' then delete from crm_bulk_listing_activity where id = OLD.id; return OLD; end if;
  if TG_OP = 'INSERT' then
    insert into crm_bulk_listing_activity (id, bulk_listing_id, kind, title, body, ref_kind, ref_id, data, actor_user_id, occurred_at, created_at)
    values (coalesce(NEW.id, nextval(pg_get_serial_sequence('crm_bulk_listing_activity', 'id'))), NEW.demand_id, NEW.kind, NEW.title, NEW.body,
      NEW.ref_kind, NEW.ref_id, coalesce(NEW.data, '{}'::jsonb), NEW.actor_user_id, coalesce(NEW.occurred_at, now()), coalesce(NEW.created_at, now()))
    returning id into NEW.id;
    return NEW;
  end if;
  update crm_bulk_listing_activity set bulk_listing_id = NEW.demand_id, kind = NEW.kind, title = NEW.title, body = NEW.body, ref_kind = NEW.ref_kind,
    ref_id = NEW.ref_id, data = NEW.data, actor_user_id = NEW.actor_user_id, occurred_at = NEW.occurred_at where id = OLD.id;
  return NEW;
end $function$;

create trigger bulk_listing_qualification_clock before insert or update on crm_bulk_listings
  for each row execute function bulk_listing_qualification_clock();
create trigger bulk_listing_status_activity after insert or update on crm_bulk_listings
  for each row execute function bulk_listing_status_activity();
create trigger crm_bulk_trade_demand_write instead of insert or update or delete on crm_bulk_trade_demand
  for each row execute function bulk_demand_view_write();
create trigger crm_bulk_trade_supply_write instead of insert or update or delete on crm_bulk_trade_supply
  for each row execute function bulk_supply_view_write();
create trigger crm_bulk_trade_demand_activity_write instead of insert or update or delete on crm_bulk_trade_demand_activity
  for each row execute function bulk_demand_activity_view_write();

drop function trade_listing_qualification_clock(),
  trade_listing_status_activity(), trade_demand_view_write(), trade_supply_view_write(), trade_demand_activity_view_write();

-- Trade rows carried the marketplace listing id under "listing_id" in spec; say what it is.
update crm_bulk_listings set spec = (spec - 'listing_id') || jsonb_build_object('marketplace_listing_id', spec->'listing_id')
where spec ? 'is_trade' and spec ? 'listing_id';

commit;
