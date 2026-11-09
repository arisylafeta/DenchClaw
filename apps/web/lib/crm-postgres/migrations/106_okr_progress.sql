-- OKR viewer: hand-kept progress for key results that are milestones rather than counts
-- (for example "finalise the written bulk trades SOP"). One row per key result key.
begin;

create table if not exists crm_okr_progress (
  kr_key text primary key,
  percent integer not null default 0 check (percent between 0 and 100),
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

commit;
