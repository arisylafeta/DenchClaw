# ReBattery loop history

Loop observations remain available as headless Postgres history. The former
DenchClaw Loops and Loop Runs CRM pages were retired on 2026-08-14. The loop
runtime and its snapshot/synchronization launchers have now been removed.
These tables preserve historical observations, not current execution, leases,
approvals, or recovery authority.

## Data flow

1. Supply an already archived schema-version-1 snapshot explicitly with `--snapshot-file <path>`.
2. `pnpm loops:history:import --snapshot-file <path>` validates that snapshot and upserts `automation_loops` and `automation_loop_runs` in one transaction.
3. No runtime binary, automatic snapshot collection, CRM object, or workspace
   projection is created. The tables remain available for historical inspection.

The importer never deletes run history. A complete snapshot tombstones missing contracts; a snapshot with fleet-level errors does not. Newer observations win when imports overlap, and a reappearing contract clears its tombstone. Historical waiting approval, blocked, failed, exhausted, and stale leases remain distinct. Caller-controlled trigger and occurrence keys are stored only as SHA-256 hashes.

## Setup

Back up the target database before production setup. Then explicitly provide the database:

```bash
LOOP_MONITOR_DATABASE_URL=postgresql:///denchclaw \
LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup \
pnpm loops:monitor:setup
```

The setup command creates the history tables and ensures the former CRM page
registrations remain absent. It does not execute a loop.

## Import archived history

Explicitly select and approve the target database before an operational import:

```bash
DATABASE_URL=postgresql:///denchclaw \
pnpm loops:history:import --snapshot-file /path/to/archived-snapshot.json
```

The archive path is required. There is no implicit runtime snapshot, binary
selection, history polling, or continuous synchronization. The v1 projection
provides no approve, reject, cancel, start, or recovery actions; the old runtime
operations are no longer installed. Supported current automation belongs to
the owning app's native commands.
