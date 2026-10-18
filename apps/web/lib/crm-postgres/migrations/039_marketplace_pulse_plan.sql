-- Marketplace Pulse plan: the growth plan on the Plan tab. Every save adds a version, so the page shows
-- the latest and older versions stay readable. Seeded with the plan agreed with Alex on 2026-10-06:
-- 9 paid deals a month by 5 Jan 2027, four fixes in funnel order, and sends goals per channel.
-- Apply only after a current backup and explicit schema approval.
begin;

create table if not exists crm_pulse_plans (
  id text primary key,
  plan jsonb not null,
  created_at timestamptz not null default now(),
  created_by text
);

create index if not exists crm_pulse_plans_created_idx on crm_pulse_plans (created_at desc);

insert into crm_pulse_plans (id, plan, created_at, created_by)
values ('seed-2026-10-06', $plan$
{
  "target_paid": 9,
  "target_date": "2027-01-05",
  "start": { "date": "2026-10-06", "paid": 2.2 },
  "levers": [
    { "id": "answer", "name": "Answer every buyer within a day", "owner": "Alex", "status": "Planned", "steps": { "deal": 0.45 } },
    { "id": "cancellations", "name": "Fix cancellations: accurate listings, call stalled payers", "owner": "Alex", "status": "Planned", "steps": { "paid": 0.8 } },
    { "id": "send-first", "name": "Send first, sign up in the same step", "owner": "Ari", "status": "Planned", "steps": { "sent": 0.75 } },
    { "id": "channels", "name": "Channels pointed at listings", "owner": "Ari", "status": "Planned", "steps": { "visitors": 690, "started": 0.1 } }
  ],
  "channels": [
    { "channel": "Direct", "goal": 10, "owner": "Alex", "action": "30 hand-made emails a month, plus calls" },
    { "channel": "Email", "goal": 8, "owner": "Ari", "action": "Tracking tags on links, then alerts that link to listings" },
    { "channel": "AI chat", "goal": 5, "owner": "Ari", "action": "100 tracked questions; Reddit and YouTube mentions" },
    { "channel": "Organic search", "goal": 6, "owner": "Ari", "action": "Model pages and a 'tell us what you need' capture" },
    { "channel": "Paid", "goal": 0, "owner": "", "action": "Paused until ads point at listings" }
  ]
}
$plan$::jsonb, '2026-10-06T20:00:00Z', null)
on conflict (id) do nothing;

commit;
