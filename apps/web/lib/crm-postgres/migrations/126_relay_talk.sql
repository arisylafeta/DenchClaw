-- Relay v2 chat: Alex talks to Relay about an email's drafts. Relay edits them, adds linked emails (a supplier, the buyer,
-- a transport partner) and keeps every earlier copy so a change can be undone. Nothing here sends: the linked emails go
-- through the same send and schedule path as the reply, behind the gap and leak guards. Additive and idempotent.
begin;

-- history: earlier bodies, [{body, at, reason, by}], newest last, about 20 kept. redo: copies taken off by Undo, newest
-- last, so Redo can put them back; any new change clears it.
alter table relay_draft add column if not exists history jsonb not null default '[]'::jsonb;
alter table relay_draft add column if not exists redo jsonb not null default '[]'::jsonb;
-- When a linked email goes: with the reply, at send_at, at send_at unless they write first, or after the buyer orders.
alter table relay_draft add column if not exists send_mode text not null default 'with_reply';
alter table relay_draft drop constraint if exists relay_draft_send_mode_check;
alter table relay_draft add constraint relay_draft_send_mode_check check (send_mode in ('with_reply', 'at', 'unless_reply', 'after_order'));
alter table relay_draft add column if not exists send_at timestamptz;
-- Ticked to go with the reply.
alter table relay_draft add column if not exists included boolean not null default true;
-- Who the email is to, for the leak guard: the buyer never sees supplier details and a supplier never sees the buyer's.
-- Null: worked out from the email (the reply follows the thread's side).
alter table relay_draft add column if not exists to_kind text;
alter table relay_draft drop constraint if exists relay_draft_to_kind_check;
alter table relay_draft add constraint relay_draft_to_kind_check check (to_kind is null or to_kind in ('buyer', 'supplier', 'other'));

-- The chat on one email. role: alex (what he typed), relay (its answer), trace (what it did, for the fold-out).
-- target: the draft Alex was talking about, or 'all'. applied: what the turn changed, added or refused.
create table if not exists relay_talk (
  id text primary key default gen_random_uuid()::text,
  item_id text not null references relay_item(id) on delete cascade,
  owner_id uuid not null references crm_users(id) on delete cascade,
  role text not null check (role in ('alex', 'relay', 'trace')),
  text text not null default '',
  target text not null default 'all',
  applied jsonb,
  created_at timestamptz not null default now()
);
create index if not exists relay_talk_item_idx on relay_talk (item_id, created_at);
commit;
