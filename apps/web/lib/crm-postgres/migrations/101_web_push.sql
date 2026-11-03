-- Web Push subscriptions: one row per browser/device, so finished or blocked chats can notify a closed or locked app.
-- Additive. prefs holds the device's notification kinds (done, input); the server filters before sending.
begin;

create table if not exists crm_push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references crm_users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  prefs jsonb not null default '{"done": true, "input": true}'::jsonb,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists crm_push_subscriptions_user_idx on crm_push_subscriptions (user_id);

commit;
