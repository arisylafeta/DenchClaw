-- Demand is a buyer's current ask; researched/stated general fit lives on the company.
-- Scoring uses the latest observed/confirmed date; estimates count half of a buyer budget.
begin;
alter table crm_bulk_trade_demand
  drop constraint if exists crm_bulk_trade_demand_status_check,
  add constraint crm_bulk_trade_demand_status_check check (status in ('open', 'qualifying', 'closed')),
  drop constraint if exists crm_bulk_trade_demand_closed_reason_check,
  add constraint crm_bulk_trade_demand_closed_reason_check check (closed_reason in
    ('bought_from_us','bought_elsewhere','no_longer_needed','expired','other','duplicate','moved_to_profile','moved_to_lot','recycling','supply','not_demand')),
  add column if not exists product_family text,
  add column if not exists fee_eur numeric check (fee_eur >= 0),
  add column if not exists price_basis text check (price_basis in ('buyer','estimate')),
  add column if not exists reputation text check (reputation in ('paid','active','email','inbound','anon')),
  add column if not exists qualify_question text,
  add column if not exists moved_to text;

create or replace function bulk_demand_expected_fee(fee_eur numeric, price_basis text, reputation text,
  asked_on date, today date default current_date) returns numeric language sql immutable as $$
  select case when fee_eur is null then null else fee_eur
    * case when price_basis = 'buyer' then 1 else 0.5 end
    * case reputation when 'paid' then 0.60 when 'active' then 0.35 when 'email' then 0.20 when 'inbound' then 0.10 else 0.03 end
    * power(0.5::numeric, greatest(0, today - asked_on)::numeric / 30) end
$$;
create or replace function bulk_demand_score(fee_eur numeric, price_basis text, reputation text,
  asked_on date, today date default current_date) returns int language sql immutable as $$
  select case when fee_eur is null then null else least(100,
    round(25 * log(1 + bulk_demand_expected_fee(fee_eur, price_basis, reputation, asked_on, today)))::int) end
$$;

alter table crm_companies
  add column if not exists buyer_profile jsonb not null default '{}'::jsonb check (jsonb_typeof(buyer_profile) = 'object'),
  add column if not exists buyer_profile_basis text check (buyer_profile_basis in ('researched','stated')),
  add column if not exists buyer_profiled_at date;
-- Existing crm_log_buyer_profile_change trigger logs all buyer_* fields, including these additions.
comment on column crm_companies.buyer_profile is 'General purchasing fit, never an open demand: buy-box spec keys plus wants and evidence_url.';
comment on column crm_bulk_trade_demand.fee_eur is 'Estimated ReBattery fee at the approved 10% fee rate; null means unknown.';
commit;
