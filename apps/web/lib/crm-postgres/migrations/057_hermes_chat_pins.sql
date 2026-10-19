-- Per-user pinned chats for the CRM sidebar (solo chats and group rooms).
-- key is the CRM conversation key (see lib/hermes-conversations.ts conversationKey), stored verbatim.
-- Separate from Hermes's own sessions.pinned archival keep flag, which this table never touches.
-- Adds one table only; existing rows are untouched.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_user_chat_pins (
  user_id uuid not null references crm_users(id) on delete cascade,
  conversation_key text not null check (char_length(conversation_key) between 1 and 2000),
  pinned_at timestamptz not null default now(),
  primary key (user_id, conversation_key)
);

commit;
