-- Relay inbox lanes: the two to four answers Relay suggests for an email that needs a reply. Alex picks one with a
-- click and Relay drafts it through the same note-to-draft path as before; nothing here is a draft or is ever sent.
begin;

-- data: {ask, answers: [{label, note, fill}]}. message_id: the email the answers were suggested for; a newer one from
-- them makes the row stale and it is read again. none: read, and nothing worth suggesting. attempts: reads of this
-- email so far; a failed read is tried again a few times, then left.
create table if not exists relay_suggest (
  item_id text primary key references relay_item(id) on delete cascade,
  owner_id uuid not null,
  message_id text not null,
  status text not null default 'preparing' check (status in ('preparing', 'ready', 'none', 'failed')),
  data jsonb not null default '{}'::jsonb,
  error text,
  attempts int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists relay_suggest_owner_idx on relay_suggest (owner_id, status);
commit;
