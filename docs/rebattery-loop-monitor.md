# ReBattery loop monitoring

Loop observations remain available as headless Postgres history. The former
DenchClaw Loops and Loop Runs CRM pages were retired on 2026-08-14. The loop
runtime remains authoritative for execution, leases, approvals, recovery, and
artifacts.

## Data flow

1. `loopctl snapshot <rebattery-automations-root> --json` reads the automation registry and privacy-bounded runtime state.
2. `pnpm loops:monitor:sync` validates snapshot schema version 1 and upserts `automation_loops` and `automation_loop_runs` in one transaction.
3. No CRM object or workspace projection is created. The tables are retained
   for recovery and direct operational inspection only.

The importer never deletes run history. A complete snapshot tombstones missing contracts; a snapshot with fleet-level errors does not. Newer observations win when syncs overlap, and a reappearing contract clears its tombstone. Waiting approval, blocked, failed, exhausted, and stale leases remain distinct. Caller-controlled trigger and occurrence keys are stored only as SHA-256 hashes.

## Setup

Back up the target database before production setup. Then explicitly provide the database:

```bash
LOOP_MONITOR_DATABASE_URL=postgresql:///denchclaw \
LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup \
pnpm loops:monitor:setup
```

The setup command creates the history tables and ensures the former CRM page
registrations remain absent. It does not execute a loop.

## Synchronize

```bash
DATABASE_URL=postgresql:///denchclaw \
LOOP_MONITOR_AUTOMATIONS_ROOT=/root/.hermes/projects/rebattery-automations \
pnpm loops:monitor:sync
```

`LOOPCTL_BIN` may select an exact installed binary. `LOOP_MONITOR_HISTORY_LIMIT` defaults to 50 activities per contract. `--snapshot-file <path>` is available for isolated verification.

The v1 projection has no approve, reject, cancel, start, or recovery actions. Those remain explicit `loopctl` operations.
