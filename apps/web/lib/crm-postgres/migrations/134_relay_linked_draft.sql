-- Relay: a reply on someone else's thread that goes with this email. Ben asks for a photo only Rick has: the reply to Rick
-- lives on Rick's own email (item_id) and also shows, ticked to go, beside the reply to Ben (linked_item_id).
-- Additive and idempotent.
begin;

alter table relay_draft add column if not exists linked_item_id text references relay_item(id) on delete set null;
create index if not exists relay_draft_linked_item_idx on relay_draft (linked_item_id) where linked_item_id is not null;

commit;
