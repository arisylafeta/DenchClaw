-- Relay lead cards: one prepared card per new-lead email. The reply on a card is assembled from fixed parts (greeting,
-- Alex's saved answers word for word, one fixed bullet per missing deal fact, close); the model only reads their email
-- into facts and questions, each kept only when its quote is found in the email.
begin;

-- data: what was read from the email (side, unit, facts, what they asked, the email as shown). state: Alex's choices on
-- the card (asks switched off, answers to the blue questions). message_id: the email the card was prepared against;
-- a newer one from them makes the card stale and it is prepared again.
create table if not exists relay_card (
  id text primary key default gen_random_uuid()::text,
  item_id text not null unique references relay_item(id) on delete cascade,
  owner_id uuid not null,
  message_id text not null,
  status text not null default 'preparing' check (status in ('preparing', 'ready', 'not_lead', 'failed', 'dismissed', 'queued')),
  data jsonb not null default '{}'::jsonb,
  state jsonb not null default '{}'::jsonb,
  draft_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists relay_card_owner_idx on relay_card (owner_id, status);

-- Alex's own answers to the questions leads keep asking (non-exclusive, where our buyers are, how we work), saved the
-- first time he picks or writes one and used word for word after that.
create table if not exists relay_lead_answer (
  owner_id uuid not null,
  topic text not null,
  text text not null,
  source text not null default 'card',
  updated_at timestamptz not null default now(),
  primary key (owner_id, topic)
);

-- What Alex did on each card (picked an answer, dropped an ask, edited, skipped, sent), for the weekly review.
create table if not exists relay_card_choice (
  id bigint generated always as identity primary key,
  card_id text not null,
  item_id text not null,
  owner_id uuid not null,
  kind text not null,
  key text,
  value text,
  at timestamptz not null default now()
);
create index if not exists relay_card_choice_at_idx on relay_card_choice (owner_id, at);

alter table relay_draft drop constraint if exists relay_draft_origin_check;
alter table relay_draft add constraint relay_draft_origin_check check (origin in ('note', 'job', 'predraft', 'card'));
commit;
