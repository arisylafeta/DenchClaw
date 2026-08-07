# ReBattery loop monitoring

DenchClaw presents durable automation loops as a read-only Postgres projection. The loop runtime remains authoritative for execution, leases, approvals, recovery, and artifacts.

## Data flow

1. `loopctl snapshot <rebattery-automations-root> --json` reads the automation registry and privacy-bounded runtime state.
2. `pnpm loops:monitor:sync` validates snapshot schema version 1 and upserts `automation_loops` and `automation_loop_runs` in one transaction.
3. The sync writes `.object.yaml` projections for `automation_loop` and `automation_loop_run` so they appear in the Dench sidebar.

The importer never deletes run history. A complete snapshot tombstones missing contracts; a snapshot with fleet-level errors does not. Newer observations win when syncs overlap, and a reappearing contract clears its tombstone. Waiting approval, blocked, failed, exhausted, and stale leases remain distinct. Caller-controlled trigger and occurrence keys are stored only as SHA-256 hashes.

## Setup

Back up the target database before production setup. Then explicitly provide the database and workspace:

```bash
LOOP_MONITOR_DATABASE_URL=postgresql:///denchclaw \
LOOP_MONITOR_WORKSPACE_ROOT=/root/.hermes/workspace \
LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup \
pnpm loops:monitor:setup
```

The setup command creates the first-class tables, registers immutable CRM objects, and writes their initial workspace projections. It does not execute a loop.

## Synchronize

```bash
DATABASE_URL=postgresql:///denchclaw \
LOOP_MONITOR_AUTOMATIONS_ROOT=/root/.hermes/projects/rebattery-automations \
LOOP_MONITOR_WORKSPACE_ROOT=/root/.hermes/workspace \
pnpm loops:monitor:sync
```

`LOOPCTL_BIN` may select an exact installed binary. `LOOP_MONITOR_HISTORY_LIMIT` defaults to 50 activities per contract. `--snapshot-file <path>` is available for isolated verification.

The v1 projection has no approve, reject, cancel, start, or recovery actions. Those remain explicit `loopctl` operations.
