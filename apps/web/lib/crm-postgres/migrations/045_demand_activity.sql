-- Activity is the demand workspace; qualification clocks never use old buyer evidence.
alter table crm_bulk_trade_demand add column if not exists qualify_asked_on date;
alter table crm_bulk_trade_demand add column if not exists qualify_entered_on date;
update crm_bulk_trade_demand set qualify_entered_on = (updated_at at time zone 'Europe/London')::date
where status = 'qualifying' and qualify_entered_on is null;

create table if not exists crm_bulk_trade_demand_activity (
  id bigserial primary key,
  demand_id text not null references crm_bulk_trade_demand(id) on delete cascade,
  kind text not null check (kind in ('note','research','outreach','call','quote','supply','status')),
  title text not null check (length(trim(title)) > 0),
  body text,
  ref_kind text check (ref_kind in ('lot','supply','stock','email','person','company','url')),
  ref_id text,
  data jsonb not null default '{}',
  actor_user_id uuid references crm_users(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists crm_bulk_trade_demand_activity_demand_time
  on crm_bulk_trade_demand_activity (demand_id, occurred_at desc);

-- All writers (UI, proposal acceptance, imports and lifecycle) share the same entry clock.
create or replace function bulk_demand_qualification_clock() returns trigger language plpgsql as $$
begin
  if new.status = 'qualifying' then
    if TG_OP = 'INSERT' then
      new.qualify_entered_on := coalesce(new.qualify_entered_on, (now() at time zone 'Europe/London')::date);
    elsif old.status is distinct from new.status then
      new.qualify_entered_on := (now() at time zone 'Europe/London')::date;
      new.qualify_asked_on := null;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bulk_demand_qualification_clock on crm_bulk_trade_demand;
create trigger bulk_demand_qualification_clock before insert or update on crm_bulk_trade_demand
for each row execute function bulk_demand_qualification_clock();

-- Atomic status history, including changes made outside the web app.
create or replace function bulk_demand_status_activity() returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    insert into crm_bulk_trade_demand_activity (demand_id, kind, title, data, actor_user_id)
    values (new.id, 'status', initcap(new.status), jsonb_build_object('status', new.status), new.created_by);
  elsif old.status is distinct from new.status then
    insert into crm_bulk_trade_demand_activity (demand_id, kind, title, data)
    values (new.id, 'status', case when new.status = 'closed' then 'Closed · ' || coalesce(new.closed_reason, 'closed')
      when new.status = 'open' then 'Opened' else 'Qualifying' end,
      jsonb_build_object('from', old.status, 'status', new.status, 'reason', new.closed_reason));
  end if;
  return new;
end $$;
drop trigger if exists bulk_demand_status_activity on crm_bulk_trade_demand;
create trigger bulk_demand_status_activity after insert or update on crm_bulk_trade_demand
for each row execute function bulk_demand_status_activity();
