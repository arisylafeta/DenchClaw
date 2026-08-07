import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

function writeAtomic(root, relativePath, content) {
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`))
    throw new Error(`workspace path escapes root: ${relativePath}`);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target) && lstatSync(target).isSymbolicLink())
    throw new Error(`refusing symlinked workspace file: ${target}`);
  const temporary = `${target}.tmp-${process.pid}`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
}

export function renderLoopObject(entryCount) {
  return `id: reb_automation_loop_object
name: automation_loop
description: Durable automation loops and current operational health
icon: refresh-cw
immutable: true
default_view: table
entry_count: ${entryCount}
fields:
  - name: Name
    type: text
    required: true
  - name: Workflow
    type: text
  - name: Lifecycle
    type: enum
    values: [active, reference]
  - name: Operation
    type: enum
    values: [scheduled, on-demand]
  - name: Current State
    type: enum
    values: [running, waiting, succeeded, failed, exhausted, blocked, cancelled, skipped, never_run, unknown]
  - name: Needs Attention
    type: boolean
  - name: Blocked
    type: boolean
  - name: Attention Reason
    type: text
  - name: Current Reason
    type: text
  - name: Last Activity
    type: date
  - name: Lease Expires
    type: date
  - name: Lease Stale
    type: boolean
  - name: Approval Required
    type: boolean
  - name: Last Scheduled Receipt
    type: date
  - name: Scheduler Health
    type: text
  - name: Owner App
    type: text
  - name: Objective
    type: richtext
  - name: Observation Error
    type: richtext
  - name: Observed At
    type: date
views:
  - name: All Loops
    view_type: table
    sort:
      - field: Needs Attention
        direction: desc
      - field: Last Activity
        direction: desc
  - name: Needs Attention
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: attention
          field: Needs Attention
          operator: is_true
    sort:
      - field: Last Activity
        direction: desc
  - name: Waiting for Approval
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: waiting
          field: Current State
          operator: is_any_of
          value: [waiting]
  - name: Blocked
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: blocked
          field: Blocked
          operator: is_true
  - name: Running
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: running
          field: Current State
          operator: is_any_of
          value: [running]
  - name: Scheduled
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: scheduled
          field: Operation
          operator: is_any_of
          value: [scheduled]
active_view: All Loops
`;
}

export function renderRunObject(entryCount) {
  return `id: reb_automation_loop_run_object
name: automation_loop_run
description: Invocation and run history for durable automation loops
icon: history
immutable: true
default_view: table
entry_count: ${entryCount}
fields:
  - name: Activity
    type: text
    required: true
  - name: Loop
    type: relation
    related_object: automation_loop
    relationship_type: many_to_one
  - name: Status
    type: enum
    values: [running, waiting, succeeded, failed, exhausted, blocked, cancelled, skipped, unknown]
  - name: Origin
    type: enum
    values: [scheduler, operator, parent, manual, legacy]
  - name: Reason
    type: text
  - name: Disposition
    type: text
  - name: Trigger Key Hash
    type: text
  - name: Started At
    type: date
  - name: Finished At
    type: date
  - name: Duration (ms)
    type: number
  - name: Approval Required
    type: boolean
  - name: Blocker
    type: richtext
  - name: Output Path
    type: text
  - name: Trace ID
    type: text
views:
  - name: Recent Runs
    view_type: table
    sort:
      - field: Started At
        direction: desc
  - name: Run Issues
    view_type: table
    filters:
      id: root
      conjunction: and
      rules:
        - id: issues
          field: Status
          operator: is_any_of
          value: [failed, exhausted, blocked]
    sort:
      - field: Started At
        direction: desc
active_view: Recent Runs
`;
}

export function writeLoopMonitorWorkspace(workspaceRoot, loopCount, runCount) {
  const root = resolve(workspaceRoot);
  writeAtomic(root, join("automation_loop", ".object.yaml"), renderLoopObject(loopCount));
  writeAtomic(root, join("automation_loop_run", ".object.yaml"), renderRunObject(runCount));
}
