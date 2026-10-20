-- Offers, listing fields and listing files, and trades (lots) as supply listings.
-- An offer is one person's conversation on one listing (a buyer on a supply listing, a seller on a demand listing,
-- or a contact on the owner's side) with a stage. Replaces buyers/contacts/bids for the new model.
-- Lots become supply listings with the SAME id (so every lot_id child row already points at a listing id).
-- All lot columns are kept in spec; nothing is dropped. Old tables are untouched. Idempotent.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_trade_offers (
  id text primary key,
  listing_id text not null references crm_trade_listings(id) on delete cascade,
  role text not null check (role in ('principal', 'contact', 'counterparty')),
  person_id text references crm_people(id) on delete set null,
  company_id text references crm_companies(id) on delete set null,
  name text,                       -- as written, for people not yet in the CRM
  contact text,                    -- as written (email, phone, "Name <email>")
  counterpart_id text references crm_trade_listings(id) on delete set null,   -- their own listing, if any
  stage text check (stage in ('to_contact', 'teaser_sent', 'specs_nda', 'bid_in', 'loi', 'won', 'declined', 'lost')),
  declined_reason text,
  wants text,
  last_touch_on date,
  last_touch_via text,
  terms jsonb not null default '{}'::jsonb check (jsonb_typeof(terms) = 'object'),  -- latest amount, unit, currency, firmness, delivery, payment, expiry
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),    -- anything else carried over (company text, phone, original status, order)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists crm_trade_offers_listing_idx on crm_trade_offers (listing_id, role);
create index if not exists crm_trade_offers_person_idx on crm_trade_offers (person_id) where person_id is not null;
create index if not exists crm_trade_offers_company_idx on crm_trade_offers (company_id) where company_id is not null;

alter table crm_trade_listing_activity add column if not exists offer_id text references crm_trade_offers(id) on delete set null;
create index if not exists crm_trade_listing_activity_offer on crm_trade_listing_activity (offer_id) where offer_id is not null;

create table if not exists crm_trade_listing_fields (
  listing_id text not null references crm_trade_listings(id) on delete cascade,
  field_key text not null,
  value text,
  status text not null check (status in ('confirmed', 'unverified', 'conflict', 'missing')),
  visibility text not null check (visibility in ('teaser', 'after_nda', 'after_loi', 'never')),
  source_label text,
  source_url text,
  source_date date,
  alternatives jsonb,
  updated_at timestamptz not null default now(),
  primary key (listing_id, field_key)
);

create table if not exists crm_trade_listing_files (
  id text primary key,
  listing_id text not null references crm_trade_listings(id) on delete cascade,
  file_name text not null,
  file_type text,
  content_type text,
  byte_size bigint not null check (byte_size >= 0),
  content bytea not null,
  source_label text,
  source_date date,
  visibility text not null check (visibility in ('teaser', 'after_nda', 'after_loi', 'never')),
  uploaded_by uuid references crm_users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists crm_trade_listing_files_listing_idx on crm_trade_listing_files (listing_id);

alter table crm_trade_listings disable trigger trade_listing_status_activity;  -- backfill must not write status activity

-- Trades (lots) as supply listings, same id. Every lot column other than the ones mapped to listing columns
-- is kept in spec, so the full lot (stage, next step, hold, auction columns, manifest ...) is preserved.
insert into crm_trade_listings (id, kind, party, summary, quantity, status, closed_reason, observed_on, spec, context, created_at, updated_at)
select l.id, 'supply',
  coalesce(nullif(btrim(l.seller_name), ''), nullif(btrim(l.seller_ref), ''), 'Unknown seller'),
  coalesce(nullif(btrim(l.summary), ''), l.title),
  nullif(concat_ws(' ', l.observed_quantity::text, l.quantity_unit), ''),
  case when l.trade_stage in ('Done', 'Lost') then 'closed' else 'open' end,
  case l.trade_stage when 'Done' then 'sold' when 'Lost' then 'gone' end,
  l.created_at::date,
  jsonb_strip_nulls(to_jsonb(l) - 'id' - 'title' - 'summary' - 'created_at' - 'updated_at') || jsonb_build_object('is_trade', true),
  jsonb_build_object('listing_title', l.title),
  l.created_at, l.updated_at
from crm_bulk_trade_lots l
on conflict (id) do update set
  party = excluded.party, summary = excluded.summary, quantity = excluded.quantity, status = excluded.status,
  closed_reason = excluded.closed_reason, spec = excluded.spec, context = excluded.context, updated_at = excluded.updated_at;

alter table crm_trade_listings enable trigger trade_listing_status_activity;

-- Fields and files follow the lots (same ids).
insert into crm_trade_listing_fields (listing_id, field_key, value, status, visibility, source_label, source_url, source_date, alternatives, updated_at)
select lot_id, field_key, value, status, visibility, source_label, source_url, source_date, alternatives, updated_at
from crm_bulk_trade_fields
on conflict (listing_id, field_key) do update set value = excluded.value, status = excluded.status, visibility = excluded.visibility,
  source_label = excluded.source_label, source_url = excluded.source_url, source_date = excluded.source_date,
  alternatives = excluded.alternatives, updated_at = excluded.updated_at;

insert into crm_trade_listing_files (id, listing_id, file_name, file_type, content_type, byte_size, content, source_label, source_date, visibility, uploaded_by, created_at)
select id, lot_id, file_name, file_type, content_type, byte_size, content, source_label, source_date, visibility, uploaded_by, created_at
from crm_bulk_trade_files
on conflict (id) do nothing;

-- Offers from buyers (counterparties). Same id as the buyer row. A person missing from person_id is matched by email
-- found in the contact text (lowest crm_people.id when an email is shared); otherwise name and contact are kept as written.
insert into crm_trade_offers (id, listing_id, role, person_id, company_id, name, contact, counterpart_id, stage, declined_reason,
  wants, last_touch_on, last_touch_via, data, created_at, updated_at)
select b.id, b.lot_id, 'counterparty',
  coalesce(b.person_id, (select min(p.id) from crm_people p where p.email is not null
     and lower(p.email) = lower((regexp_match(b.contact, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'))[1]))),
  coalesce((select d.company_id from crm_bulk_trade_demand d where d.id = b.demand_id),
           (select p.company_id from crm_people p where p.id = b.person_id)),
  b.name, b.contact,
  (select d.id from crm_trade_listings d where d.id = b.demand_id and d.kind = 'demand'),
  case b.status when 'To contact' then 'to_contact' when 'Teaser sent' then 'teaser_sent' when 'NDA, specs sent' then 'specs_nda'
    when 'Bid in' then 'bid_in' when 'LOI or deposit' then 'loi' when 'Declined: logistics' then 'declined' end,
  case when b.status like 'Declined:%' then btrim(substr(b.status, 10)) end,
  b.wants, b.last_touch_on, b.last_touch_via,
  jsonb_build_object('status_text', b.status, 'person_id_as_recorded', b.person_id, 'chase_on', b.chase_on),
  b.created_at, b.updated_at
from crm_bulk_trade_buyers b
on conflict (id) do update set person_id = excluded.person_id, company_id = excluded.company_id, name = excluded.name,
  contact = excluded.contact, counterpart_id = excluded.counterpart_id, stage = excluded.stage, declined_reason = excluded.declined_reason,
  wants = excluded.wants, last_touch_on = excluded.last_touch_on, last_touch_via = excluded.last_touch_via,
  data = excluded.data, updated_at = excluded.updated_at;

-- Latest bid per buyer becomes the offer's terms; every bid is also an activity row on the offer.
update crm_trade_offers o set terms = jsonb_strip_nulls(jsonb_build_object('amount', x.amount, 'unit', x.unit, 'currency', x.currency,
    'firmness', x.firmness, 'delivery_terms', x.delivery_terms, 'payment_terms', x.payment_terms, 'expires_on', x.expires_on, 'bid_id', x.id))
from (select distinct on (buyer_id) * from crm_bulk_trade_bids order by buyer_id, created_at desc, id desc) x
where o.id = x.buyer_id;

insert into crm_trade_listing_activity (listing_id, offer_id, person_id, kind, title, data, actor_user_id, occurred_at)
select bid.lot_id, bid.buyer_id, o.person_id, 'quote',
  'Bid · ' || bid.amount::text || ' ' || bid.currency || '/' || bid.unit || ' (' || bid.firmness || ')',
  jsonb_strip_nulls(jsonb_build_object('bid_id', bid.id, 'amount', bid.amount, 'unit', bid.unit, 'currency', bid.currency, 'firmness', bid.firmness,
    'delivery_terms', bid.delivery_terms, 'payment_terms', bid.payment_terms, 'expires_on', bid.expires_on)),
  bid.actor_user_id, bid.created_at
from crm_bulk_trade_bids bid join crm_trade_offers o on o.id = bid.buyer_id
where not exists (select 1 from crm_trade_listing_activity a where a.kind = 'quote' and (a.data->>'bid_id')::bigint = bid.id);

-- Offers from trade contacts (the owner's side). Same id as the contact row.
insert into crm_trade_offers (id, listing_id, role, person_id, company_id, name, contact, data, created_at)
select c.id, c.lot_id, 'contact',
  (select min(p.id) from crm_people p where p.email is not null and lower(p.email) = lower(c.email)),
  (select p.company_id from crm_people p where p.id = (select min(p2.id) from crm_people p2 where p2.email is not null and lower(p2.email) = lower(c.email))),
  c.name, c.email,
  jsonb_strip_nulls(jsonb_build_object('company_text', c.company, 'phone', c.phone, 'sort_order', c.sort_order)),
  c.created_at
from crm_bulk_trade_contacts c
on conflict (id) do update set person_id = excluded.person_id, company_id = excluded.company_id, name = excluded.name,
  contact = excluded.contact, data = excluded.data;

commit;
