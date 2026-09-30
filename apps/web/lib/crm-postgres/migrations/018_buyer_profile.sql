-- Buyer profile on companies: who the buyer is and how we deal with them. What they buy lives in
-- buy-boxes (crm_bulk_trade_demand), not here.
--   buyer_stage     how well they know us, set by hand: Identified, Contacted, Responded, In conversation,
--                   Qualified, Bidding, Customer. crm_buyer_engagement suggests one from the data.
--   the rest        tier, owner, capabilities, waste permit, standard terms, collection, past issues,
--                   outreach notes, main contact, next step.
-- Every change to a buyer_* column is logged with a date in crm_buyer_profile_changes.
-- Also adds the five buyer research columns production already has, so every database matches.
-- Columns are registered in crm_fields, so they show, filter and edit in the Companies table.
-- Adds columns, a table, a trigger, a view and field rows only. Apply only after a current backup and explicit
-- schema approval.
begin;

alter table crm_companies
  add column if not exists buyer_category text,
  add column if not exists buyer_workstream_status text,
  add column if not exists buyer_evidence text,
  add column if not exists buyer_exclusion_reason text,
  add column if not exists buyer_last_reviewed_at timestamptz,
  add column if not exists buyer_stage text check (buyer_stage in
    ('Identified', 'Contacted', 'Responded', 'In conversation', 'Qualified', 'Bidding', 'Customer')),
  add column if not exists buyer_stage_changed_on date,
  add column if not exists buyer_tier text check (buyer_tier in ('A', 'B', 'C')),
  add column if not exists buyer_owner text check (buyer_owner in ('Alex', 'Ari')),
  add column if not exists buyer_capabilities text[],
  add column if not exists buyer_can_receive_waste boolean,
  add column if not exists buyer_accepts_standard_terms text check (buyer_accepts_standard_terms in ('Yes', 'No', 'Not asked')),
  add column if not exists buyer_collection text,
  add column if not exists buyer_past_issues text,
  add column if not exists buyer_outreach_notes text,
  add column if not exists buyer_main_contact_id text references crm_people(id) on delete set null,
  add column if not exists buyer_next_step text,
  add column if not exists buyer_next_step_on date;

create index if not exists crm_companies_buyer_stage_idx on crm_companies (buyer_stage) where buyer_stage is not null;

-- One row per changed buyer_* column: the dated history of the profile.
create table if not exists crm_buyer_profile_changes (
  id bigserial primary key,
  company_id text not null references crm_companies(id) on delete cascade,
  field text not null,
  old_value jsonb,
  new_value jsonb,
  changed_at timestamptz not null default now()
);
create index if not exists crm_buyer_profile_changes_company_idx on crm_buyer_profile_changes (company_id, changed_at desc);

create or replace function crm_log_buyer_profile_change() returns trigger language plpgsql as $$
declare
  key text;
  before jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  after jsonb := to_jsonb(new);
begin
  for key in select k from jsonb_object_keys(after) k where k like 'buyer\_%' and k <> 'buyer_stage_changed_on' loop
    if coalesce(before -> key, 'null'::jsonb) is distinct from after -> key then
      insert into crm_buyer_profile_changes (company_id, field, old_value, new_value)
      values (new.id, key, nullif(before -> key, 'null'::jsonb), nullif(after -> key, 'null'::jsonb));
    end if;
  end loop;
  return null;
end $$;

create or replace function crm_stamp_buyer_stage() returns trigger language plpgsql as $$
begin
  if new.buyer_stage is distinct from old.buyer_stage then
    new.buyer_stage_changed_on := current_date;
  end if;
  return new;
end $$;

drop trigger if exists trg_crm_companies_buyer_profile_changes on crm_companies;
create trigger trg_crm_companies_buyer_profile_changes after insert or update on crm_companies
  for each row execute function crm_log_buyer_profile_change();
drop trigger if exists trg_crm_companies_buyer_stage_date on crm_companies;
create trigger trg_crm_companies_buyer_stage_date before update on crm_companies
  for each row execute function crm_stamp_buyer_stage();

-- What each company has done with us, from the data we already hold. Email counts both mailboxes; WhatsApp
-- and calls outside Granola are not in the CRM. suggested_stage never goes past Bidding on email alone, and
-- never suggests Qualified: that needs a buy-box, which a person confirms.
create or replace view crm_buyer_engagement as
with people as (
  select id as person_id, company_id from crm_people where company_id is not null
),
mail as (
  select p.company_id,
    max(m.sent_at) filter (where m.from_person_id = p.person_id and coalesce(m.from_email, '') !~* '@rebattery\.io$') as last_in_at,
    count(*) filter (where m.from_person_id = p.person_id and coalesce(m.from_email, '') !~* '@rebattery\.io$'
                       and m.sent_at > now() - interval '90 days') as emails_in_90d
  from crm_email_messages m join people p on p.person_id = m.from_person_id
  group by p.company_id
),
sent as (
  select p.company_id, max(m.sent_at) as last_out_at,
    count(distinct m.id) filter (where m.sent_at > now() - interval '90 days') as emails_out_90d
  from crm_email_message_recipients r join crm_email_messages m on m.id = r.message_id
  join people p on p.person_id = r.person_id
  where m.from_email ~* '@rebattery\.io$'
  group by p.company_id
),
meetings as (
  select p.company_id, count(distinct a.event_id) as meetings, max(e.start_at) as last_meeting_at
  from crm_calendar_event_attendees a join crm_calendar_events e on e.id = a.event_id
  join people p on p.person_id = a.person_id
  group by p.company_id
),
campaigns as (
  select coalesce(s.company_id, p.company_id) as company_id,
    count(*) filter (where s.provider_link_clicked_at is not null) as campaign_clicks,
    max(s.provider_link_clicked_at) as last_click_at
  from crm_campaign_sends s left join people p on p.person_id = s.person_id
  group by 1
),
auctions as (
  select p.company_id, sum(ap.view_count) as auction_views, sum(ap.offer_count) as auction_offers,
    max(ap.last_activity_at) as last_auction_at
  from crm_bulk_trade_auction_people ap join people p on p.person_id = ap.person_id
  group by p.company_id
),
trades as (
  select p.company_id, count(distinct b.lot_id) as trades_offered,
    count(distinct b.lot_id) filter (where b.status = 'Won') as trades_won,
    count(bid.id) as bids, max(bid.created_at) as last_bid_at
  from crm_bulk_trade_buyers b join people p on p.person_id = b.person_id
  left join crm_bulk_trade_bids bid on bid.buyer_id = b.id
  group by p.company_id
),
demand as (
  select company_id,
    count(*) filter (where status = 'open' and kind = 'request') as open_requests,
    count(*) filter (where status = 'open' and kind = 'standing') as open_buy_boxes,
    count(*) filter (where status = 'open' and kind = 'standing' and basis = 'agreed') as agreed_buy_boxes,
    count(*) filter (where source_kind = 'survey') as surveys
  from crm_bulk_trade_demand where company_id is not null group by company_id
),
waiting as (
  select company_id, min(waiting_since) as waiting_since from crm_bulk_trade_buyer_waiting
  where waiting_since is not null and company_id is not null group by company_id
)
select c.id as company_id,
  mail.last_in_at, sent.last_out_at, waiting.waiting_since,
  coalesce(mail.emails_in_90d, 0) as emails_in_90d, coalesce(sent.emails_out_90d, 0) as emails_out_90d,
  coalesce(meetings.meetings, 0) as meetings, meetings.last_meeting_at,
  coalesce(campaigns.campaign_clicks, 0) as campaign_clicks, campaigns.last_click_at,
  coalesce(auctions.auction_views, 0) as auction_views, coalesce(auctions.auction_offers, 0) as auction_offers,
  auctions.last_auction_at,
  coalesce(trades.trades_offered, 0) as trades_offered, coalesce(trades.trades_won, 0) as trades_won,
  coalesce(trades.bids, 0) as bids, trades.last_bid_at,
  coalesce(demand.open_requests, 0) as open_requests, coalesce(demand.open_buy_boxes, 0) as open_buy_boxes,
  coalesce(demand.agreed_buy_boxes, 0) as agreed_buy_boxes, coalesce(demand.surveys, 0) as surveys,
  greatest(mail.last_in_at, meetings.last_meeting_at, campaigns.last_click_at, auctions.last_auction_at, trades.last_bid_at)
    as last_heard_at,
  case
    when coalesce(trades.trades_won, 0) > 0 then 'Customer'
    when coalesce(trades.bids, 0) > 0 or coalesce(auctions.auction_offers, 0) > 0 then 'Bidding'
    when coalesce(meetings.meetings, 0) > 0 or (mail.last_in_at is not null and sent.last_out_at is not null
      and coalesce(mail.emails_in_90d, 0) >= 2) then 'In conversation'
    when mail.last_in_at is not null or campaigns.last_click_at is not null or coalesce(auctions.auction_views, 0) > 0
      or coalesce(demand.surveys, 0) > 0 then 'Responded'
    when sent.last_out_at is not null then 'Contacted'
    else 'Identified'
  end as suggested_stage
from crm_companies c
left join mail on mail.company_id = c.id
left join sent on sent.company_id = c.id
left join meetings on meetings.company_id = c.id
left join campaigns on campaigns.company_id = c.id
left join auctions on auctions.company_id = c.id
left join trades on trades.company_id = c.id
left join demand on demand.company_id = c.id
left join waiting on waiting.company_id = c.id;

-- Field registry rows, so the columns show, filter and edit in the Companies table.
insert into crm_fields (id, object_id, name, type, canonical_column, enum_values, enum_multiple, related_object_id,
                        relationship_type, sort_order)
select 'fld_company_' || v.col, o.id, v.name, v.type, v.col, v.enum_values::jsonb, v.multiple,
  case when v.related is not null then (select id from crm_objects where name = v.related) end,
  case when v.related is not null then 'many_to_one' end, v.sort_order
from crm_objects o, (values
  ('buyer_category', 'Buyer Category', 'enum', null, false, null, 200),
  ('buyer_workstream_status', 'Buyer Workstream Status', 'enum', '["New", "Needs Review", "Approved", "Excluded", "Watchlist"]', false, null, 201),
  ('buyer_evidence', 'Buyer Evidence', 'richtext', null, false, null, 202),
  ('buyer_exclusion_reason', 'Buyer Exclusion Reason', 'richtext', null, false, null, 203),
  ('buyer_last_reviewed_at', 'Buyer Last Reviewed At', 'date', null, false, null, 204),
  ('buyer_stage', 'Buyer Stage', 'enum', '["Identified", "Contacted", "Responded", "In conversation", "Qualified", "Bidding", "Customer"]', false, null, 205),
  ('buyer_stage_changed_on', 'Buyer Stage Changed On', 'date', null, false, null, 206),
  ('buyer_tier', 'Buyer Tier', 'enum', '["A", "B", "C"]', false, null, 207),
  ('buyer_owner', 'Buyer Owner', 'enum', '["Alex", "Ari"]', false, null, 208),
  ('buyer_capabilities', 'Buyer Capabilities', 'select', '["Dismantle packs", "Test and grade", "BMS repair", "Cell rebuild", "Recycle", "Integrate systems", "HV workshop", "Dangerous-goods shipping"]', true, null, 209),
  ('buyer_can_receive_waste', 'Buyer Can Receive Waste', 'boolean', null, false, null, 210),
  ('buyer_accepts_standard_terms', 'Buyer Accepts Standard Terms', 'enum', '["Yes", "No", "Not asked"]', false, null, 211),
  ('buyer_collection', 'Buyer Collection', 'text', null, false, null, 212),
  ('buyer_past_issues', 'Buyer Past Issues', 'richtext', null, false, null, 213),
  ('buyer_outreach_notes', 'Buyer Outreach Notes', 'richtext', null, false, null, 214),
  ('buyer_main_contact_id', 'Buyer Main Contact', 'relation', null, false, 'people', 215),
  ('buyer_next_step', 'Buyer Next Step', 'text', null, false, null, 216),
  ('buyer_next_step_on', 'Buyer Next Step On', 'date', null, false, null, 217)
) as v(col, name, type, enum_values, multiple, related, sort_order)
where o.name = 'company'
on conflict (object_id, name) do nothing;

commit;
