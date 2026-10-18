-- Screening is independent of capture/import and never applies business changes.
alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_source_kind_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_source_kind_check
  check (source_kind in ('gmail','granola','auction','whatsapp'));
alter table crm_bulk_trade_demand drop constraint if exists crm_bulk_trade_demand_source_kind_check;
alter table crm_bulk_trade_demand add constraint crm_bulk_trade_demand_source_kind_check
  check (source_kind in ('research','survey','email','call','auction','manual','import','whatsapp'));
alter table crm_bulk_trade_demand add column if not exists source_thread text;
create table whatsapp_screen_checkpoint (
  message_id text primary key references whatsapp_message(id),
  source_version text not null,
  screened_at timestamptz not null default now()
);
-- One source creates one pending demand/observation, regardless of model wording or replay.
create unique index whatsapp_proposal_source_once on crm_bulk_trade_proposals(source_id)
  where source_kind='whatsapp';
create function whatsapp_source_version(m whatsapp_message) returns text language sql immutable as $$
  select md5(jsonb_build_array(m.edit_version,m.projection_order,m.body,extract(epoch from m.deleted_at),
    m.metadata - 'reactions',m.attachment,m.sender_identity_id,m.direction,extract(epoch from m.occurred_at))::text)
$$;
create function whatsapp_invalidate_proposals() returns trigger language plpgsql as $$
begin
  if whatsapp_source_version(old) is distinct from whatsapp_source_version(new) then
    update crm_bulk_trade_proposals set status='ignored',quote='',summary='WhatsApp source changed; review current source',
      proposed=jsonb_build_object('invalidated',true,'source_version',whatsapp_source_version(new))
      where source_kind='whatsapp' and source_id=new.id and status='new';
  end if;
  if new.deleted_at is not null or new.body is null or new.metadata->>'content_redacted'='true' then
    update crm_bulk_trade_proposals set quote='',summary='WhatsApp source removed',proposed=proposed - 'wants' - 'contact'
      where source_kind='whatsapp' and source_id=new.id;
    update crm_bulk_trade_demand set source_quote=null where source_kind='whatsapp' and source_id=new.id;
    update crm_bulk_trade_proposals set undo=jsonb_set(undo,'{after,source_quote}','null'::jsonb)
      where source_kind='whatsapp' and source_id=new.id and undo->'after'->>'source_id'=new.id;
    update crm_bulk_trade_proposals set undo=jsonb_set(undo,'{before,source_quote}','null'::jsonb)
      where source_kind='whatsapp' and source_id=new.id and undo->'before'->>'source_id'=new.id;
  end if;
  return new;
end $$;
-- Empty quotes are reserved for invalidated/erased source copies.
alter table crm_bulk_trade_proposals drop constraint if exists crm_bulk_trade_proposals_quote_check;
alter table crm_bulk_trade_proposals add constraint crm_bulk_trade_proposals_quote_check
  check (length(trim(quote)) > 0 or source_kind='whatsapp');
create trigger whatsapp_source_invalidation after update on whatsapp_message
  for each row execute function whatsapp_invalidate_proposals();
