-- Marketplace Pulse suggestions: every three days a Hermes job reads the weekly numbers and writes
-- a few concrete suggestions (scripts/rebattery/marketplace_pulse_suggest.py). On the page each one
-- is marked Doing, Done or Dismissed; the metric's value when it was suggested is kept, so Done
-- suggestions become a learning log of what moved the numbers.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_pulse_suggestions (
  id text primary key,
  batch date not null,
  title text not null,
  evidence text not null,
  action text not null,
  metric text,
  owner text not null check (owner in ('Alex', 'Ari', 'Product')),
  status text not null default 'New' check (status in ('New', 'Doing', 'Done', 'Dismissed')),
  -- The metric's value in the last full week when suggested.
  before_week date,
  before_value numeric,
  status_changed_at timestamptz,
  status_changed_by text,
  created_at timestamptz not null default now()
);

create index if not exists crm_pulse_suggestions_batch_idx on crm_pulse_suggestions (batch desc);

commit;
