-- 112: The front door (bulk and Relay slice 2): each lead's route, the checklist state behind "Qualified", and the
-- Qualified rule Alex set on 12 Nov 2026. Safe to run twice.
--
-- Route: every inbound lead gets one of bulk, marketplace, jules or recycling, with a one-line reason. Relay keeps it on
-- the lead card (relay_card.data) and, where a deal exists, on the listing (crm_bulk_listings.route, route_reason).
--
-- Qualified (bulk_listing_qualified, same name and signature, so the stage functions of 111 pick it up):
--   1. every item on the route's checklist (bulk_listing_check_keys) is answered, or marked "they cannot provide it";
--   2. a person ticked each of those items as checked (crm_bulk_listing_fields.checked_at);
--   3. a person ticked the deal Qualified (crm_bulk_listings.qualified_at).
-- Price and when are on every checklist and asked for in both asks, but the tick does not need them; the deal then
-- shows "No price" / "No date". Listings the old rule (migration 085) qualified keep Qualified: they get
-- qualified_by = 'before migration 112', which the new rule accepts as it is. Clear it to make one go through the new rule.
--
-- Checklist state lives on crm_bulk_listing_fields, one row per item under the field_key bulk_listing_check_field()
-- names (model, quantity, location, soh, ...). A row may carry only state (value null, status 'missing') until they answer.
-- More than one contact for a deal: extra people are crm_bulk_offers rows with role 'contact' (as since migration 059);
-- the listing's person_id or email stays the main contact. Only an index is added for finding a deal by a contact's email.
begin;

alter table crm_bulk_listings
  add column if not exists route text,
  add column if not exists route_reason text,
  add column if not exists qualified_at timestamptz,
  add column if not exists qualified_by text;
alter table crm_bulk_listings drop constraint if exists crm_bulk_listings_route_check;
alter table crm_bulk_listings add constraint crm_bulk_listings_route_check
  check (route is null or route in ('bulk', 'marketplace', 'jules', 'recycling'));
alter table crm_bulk_listings drop constraint if exists crm_bulk_listings_qualified_pair_check;
alter table crm_bulk_listings add constraint crm_bulk_listings_qualified_pair_check check ((qualified_at is null) = (qualified_by is null));

-- asked_at / asked_count: when we last asked for the item and in how many emails (the first and second ask).
-- cannot_provide: they told us they cannot give it. checked_by / checked_at: the person who checked the answer.
alter table crm_bulk_listing_fields
  add column if not exists asked_at timestamptz,
  add column if not exists asked_count int not null default 0,
  add column if not exists cannot_provide boolean not null default false,
  add column if not exists checked_by text,
  add column if not exists checked_at timestamptz;
alter table crm_bulk_listing_fields drop constraint if exists crm_bulk_listing_fields_asked_count_check;
alter table crm_bulk_listing_fields add constraint crm_bulk_listing_fields_asked_count_check check (asked_count >= 0);
alter table crm_bulk_listing_fields drop constraint if exists crm_bulk_listing_fields_checked_pair_check;
alter table crm_bulk_listing_fields add constraint crm_bulk_listing_fields_checked_pair_check check ((checked_by is null) = (checked_at is null));

-- A lead card whose reply went out. Relay opens the deal then (on send, not on the click), so Undo leaves nothing behind.
alter table relay_card drop constraint if exists relay_card_status_check;
alter table relay_card add constraint relay_card_status_check
  check (status in ('preparing', 'ready', 'not_lead', 'failed', 'dismissed', 'queued', 'sent'));

-- The checklist items a "Draft the ask" email asks for, so they count as asked once it is sent.
alter table relay_draft add column if not exists ask_keys text[] not null default '{}';

create index if not exists crm_bulk_offers_contact_email_idx on crm_bulk_offers (lower(contact)) where role = 'contact' and contact is not null;

-- The crm_bulk_listing_fields key that holds a checklist item's state. TS twin: CHECK_FIELD in relay-front-door.ts.
create or replace function bulk_listing_check_field(kind text, key text) returns text language sql immutable as $$
  select case kind || ':' || key
    when 'supply:what' then 'model'
    when 'supply:how_many' then 'quantity'
    when 'supply:where' then 'location'
    when 'supply:health' then 'soh'
    when 'supply:condition' then 'condition'
    when 'supply:price' then 'seller_price'
    when 'supply:when' then 'clear_by'
    when 'demand:what' then 'product_family'
    when 'demand:how_many' then 'quantity'
    when 'demand:where' then 'location'
    when 'demand:condition' then 'condition'
    when 'demand:price' then 'max_price'
    when 'demand:when' then 'needed_by'
    when 'demand:health' then 'min_soh'
  end
$$;

-- The items the Qualified tick needs, by route (resale or recycling) and kind. TS twin: QUALIFY_KEYS.
-- keys resale supply: array['what', 'how_many', 'where', 'health']
-- keys resale demand: array['what', 'how_many', 'where']
-- keys recycling supply: array['what', 'how_many', 'where', 'condition']
-- keys recycling demand: array['what', 'how_many', 'where']
create or replace function bulk_listing_check_keys(listing_id text) returns text[] language sql stable as $$
  select case
    when l.kind = 'demand' then array['what', 'how_many', 'where']
    when l.route = 'recycling' or l.context->>'recycling' = 'true' then array['what', 'how_many', 'where', 'condition']
    else array['what', 'how_many', 'where', 'health']
  end
  from crm_bulk_listings l where l.id = listing_id
$$;

-- An item is answered when its field row holds a value (any status but missing) or the listing's own column or spec
-- holds it; it is done when it is answered or they cannot provide it, and a person checked it.
create or replace function bulk_listing_check_answered(listing_id text, key text) returns boolean language sql stable as $$
  select coalesce((select
      exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id and f.field_key = bulk_listing_check_field(l.kind, key)
        and nullif(btrim(coalesce(f.value, '')), '') is not null and f.status <> 'missing')
      or case key
        when 'what' then l.kind = 'demand' and (nullif(btrim(coalesce(l.spec->>'product_family', '')), '') is not null
          or (jsonb_typeof(l.spec->'makes') = 'array' and jsonb_array_length(l.spec->'makes') > 0))
        when 'how_many' then nullif(btrim(coalesce(l.quantity, '')), '') is not null or l.spec ? 'volume'
        when 'where' then nullif(btrim(coalesce(l.location, '')), '') is not null
        when 'health' then l.kind = 'supply' and exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id
          and f.field_key in ('soh', 'test_data') and nullif(btrim(coalesce(f.value, '')), '') is not null and f.status <> 'missing')
        when 'when' then l.clear_by is not null or l.spec ? 'needed_by'
        when 'price' then l.spec ? 'max_price'
        else false
      end
    from crm_bulk_listings l where l.id = listing_id), false)
$$;

create or replace function bulk_listing_check_done(listing_id text, key text) returns boolean language sql stable as $$
  select coalesce((select
      exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id and f.field_key = bulk_listing_check_field(l.kind, key)
        and f.checked_at is not null)
      and (bulk_listing_check_answered(l.id, key) or exists (select 1 from crm_bulk_listing_fields f where f.bulk_listing_id = l.id
        and f.field_key = bulk_listing_check_field(l.kind, key) and f.cannot_provide))
    from crm_bulk_listings l where l.id = listing_id), false)
$$;

-- Keep Qualified on the listings the old rule qualified, before the rule changes. Runs only while the old body is in
-- place: on a second run the new rule finds no listing qualified without a tick, so nothing changes.
update crm_bulk_listings l set qualified_at = now(), qualified_by = 'before migration 112'
  where l.qualified_at is null and l.status <> 'closed' and bulk_listing_qualified(l.id);

create or replace function bulk_listing_qualified(listing_id text) returns boolean language sql stable as $$
  select coalesce((select l.qualified_by = 'before migration 112'
      or (l.qualified_at is not null
        and (l.company_id is not null or l.person_id is not null or l.email is not null)
        and not exists (select 1 from unnest(bulk_listing_check_keys(l.id)) k(key) where not bulk_listing_check_done(l.id, k.key)))
    from crm_bulk_listings l where l.id = listing_id), false)
$$;

-- The stage now also moves on the tick and the route.
drop trigger if exists bulk_listing_stage_events on crm_bulk_listings;
create trigger bulk_listing_stage_events after insert or update of kind, status, closed_reason, company_id, person_id,
  quantity, location, spec, context, hold_until, clear_by, email, route, qualified_at, qualified_by
  on crm_bulk_listings for each row execute function bulk_listing_stage_events();

commit;
