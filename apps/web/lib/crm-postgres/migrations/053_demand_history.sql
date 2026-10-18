-- History categories preserve audit provenance without reopening demand.
ALTER TABLE crm_bulk_trade_demand DROP CONSTRAINT IF EXISTS crm_bulk_trade_demand_closed_reason_check;
ALTER TABLE crm_bulk_trade_demand ADD CONSTRAINT crm_bulk_trade_demand_closed_reason_check CHECK
  (closed_reason IN ('bought_from_us', 'bought_elsewhere', 'no_longer_needed', 'expired', 'other', 'duplicate',
    'moved_to_profile', 'moved_to_lot', 'offer_reply', 'research_profile', 'recycling', 'supply', 'not_demand'));

CREATE OR REPLACE FUNCTION bulk_demand_status_activity() RETURNS trigger LANGUAGE plpgsql AS $$
begin
  if TG_OP = 'INSERT' then
    insert into crm_bulk_trade_demand_activity (demand_id, kind, title, data, actor_user_id)
    values (new.id, 'status', initcap(new.status), jsonb_build_object('status', new.status), new.created_by);
  elsif old.status is distinct from new.status then
    insert into crm_bulk_trade_demand_activity (demand_id, kind, title, data)
    values (new.id, 'status', case when new.status = 'closed' then 'Closed · ' || coalesce(new.closed_reason, 'closed')
      when new.status = 'open' then 'Opened' else 'Qualifying' end,
      jsonb_build_object('from', old.status, 'status', new.status, 'reason', new.closed_reason));
  elsif new.status = 'closed' and old.closed_reason is distinct from new.closed_reason then
    insert into crm_bulk_trade_demand_activity (demand_id, kind, title, data)
    values (new.id, 'status', 'Category · ' || new.closed_reason,
      jsonb_build_object('from_reason', old.closed_reason, 'reason', new.closed_reason, 'status', new.status));
  end if;
  return new;
end $$;
