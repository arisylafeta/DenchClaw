-- Relay learns from what Alex sends. Additive.
-- relay_draft.original_body: the main copy as Relay wrote it (signature split off), compared with sent_body once Gmail
--   accepted the send. edit_requests: what he asked the AI panel to change. origin: where the draft came from.
-- relay_rule.source/state: his own rules and learned ones, each active, proposed (waiting for his approval) or rejected
--   (never proposed again). action/target_id: a proposal to remove an active learned rule. evidence: the drafts behind it.
-- relay_learn_run: the weekly learning run, for the Rules page.
begin;

alter table relay_draft add column if not exists original_body text;
alter table relay_draft add column if not exists sent_body text;
alter table relay_draft add column if not exists sent_at timestamptz;
alter table relay_draft add column if not exists edit_requests jsonb not null default '[]'::jsonb;
alter table relay_draft add column if not exists origin text not null default 'note';
alter table relay_draft drop constraint if exists relay_draft_origin_check;
alter table relay_draft add constraint relay_draft_origin_check check (origin in ('note', 'job', 'predraft'));

alter table relay_rule add column if not exists source text not null default 'alex';
alter table relay_rule add column if not exists state text not null default 'active';
alter table relay_rule add column if not exists action text not null default 'add';
alter table relay_rule add column if not exists target_id text references relay_rule(id) on delete cascade;
alter table relay_rule add column if not exists evidence jsonb not null default '[]'::jsonb;
alter table relay_rule add column if not exists why text not null default '';
alter table relay_rule add column if not exists decided_at timestamptz;
alter table relay_rule drop constraint if exists relay_rule_source_check;
alter table relay_rule add constraint relay_rule_source_check check (source in ('alex', 'learned'));
alter table relay_rule drop constraint if exists relay_rule_state_check;
alter table relay_rule add constraint relay_rule_state_check check (state in ('active', 'proposed', 'rejected'));
alter table relay_rule drop constraint if exists relay_rule_action_check;
alter table relay_rule add constraint relay_rule_action_check check (action in ('add', 'remove') and (action = 'add' or target_id is not null));
create index if not exists relay_rule_owner_state_idx on relay_rule (owner_id, state);

create table if not exists relay_learn_run (
  id text primary key default gen_random_uuid()::text,
  owner_id uuid not null references crm_users(id) on delete cascade,
  ran_at timestamptz not null default now(),
  sent integer not null default 0,
  unchanged integer not null default 0,
  edited integer not null default 0,
  proposed integer not null default 0,
  note text not null default ''
);
create index if not exists relay_learn_run_owner_idx on relay_learn_run (owner_id, ran_at desc);

grant select, insert, update, delete on relay_learn_run to crm_web_sql;
grant select, insert, update, delete on relay_learn_run to crm_agent_sql;
commit;
