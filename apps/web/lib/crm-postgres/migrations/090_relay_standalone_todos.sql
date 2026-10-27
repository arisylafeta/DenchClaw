-- Relay: to-dos Alex adds himself on the To-dos tab, not tied to an email. Additive.
begin;
alter table relay_todo add column if not exists owner_id uuid references crm_users(id) on delete cascade;
update relay_todo t set owner_id = i.owner_id from relay_item i where i.id = t.item_id and t.owner_id is null;
alter table relay_todo alter column item_id drop not null;
alter table relay_todo drop constraint if exists relay_todo_kind_check;
alter table relay_todo add constraint relay_todo_kind_check check (kind in ('suggested', 'promise', 'manual'));
create index if not exists relay_todo_owner_idx on relay_todo (owner_id, state);
commit;
