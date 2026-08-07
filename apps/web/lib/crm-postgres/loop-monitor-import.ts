import { withPgTransaction } from "../postgres";

type SnapshotError = { code: string; message: string };
type SnapshotRun = {
  id: string;
  triggerKeyHash: string;
  status: string;
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  approvedAt: string | null;
  outputExists: boolean | null;
};
type SnapshotInvocation = {
  id: string;
  runId: string | null;
  triggerKeyHash: string;
  origin: string;
  kind: string;
  status: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  occurrenceHash: string | null;
  disposition: string | null;
  blocker?: unknown;
};
type SnapshotActivity = {
  id: string;
  type: "invocation" | "legacy_run";
  at: string;
  invocation: SnapshotInvocation | null;
  run: SnapshotRun | null;
};
type ContractSnapshot = {
  id: string;
  name: string;
  path: string;
  workflowId: string;
  ownerApp: string;
  lifecycle: string;
  operation: string;
  role: string;
  trigger: string;
  mode?: string | null;
  objective?: string | null;
  definitionHash: string | null;
  state: { rawStatus: string; reason: string | null; disposition: string | null };
  needsAttention: { value: boolean; code: string | null; since: string | null };
  approval: { required: boolean; pending: boolean; attentionAfterSeconds: number | null };
  output: { configured: boolean; latestExists: boolean | null };
  scheduler: { owner: string | null; health: string };
  lease: { runId: string; owner: string; generation: number; expiresAt: string; stale: boolean } | null;
  latestRun: SnapshotRun | null;
  latestInvocation: SnapshotInvocation | null;
  latestScheduledInvocationAt?: string | null;
  activities: SnapshotActivity[];
  errors: SnapshotError[];
};
export type LoopMonitorSnapshot = {
  schemaVersion: number;
  generatedAt: string;
  registry: { path: string; version: number; sha256: string };
  workflows: Array<{ id: string; name: string; operation: string; schedulerOwner: string | null; contractIds: string[] }>;
  contracts: ContractSnapshot[];
  errors: SnapshotError[];
};

type LoopProjection = Record<string, unknown> & { id: string };
type RunProjection = Record<string, unknown> & { id: string };

function assertTimestamp(value: string, label: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}
function compactBlocker(value: unknown): string | null {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= 2000 ? text : `${text.slice(0, 1997)}...`;
}
function activityStatus(activity: SnapshotActivity): string {
  return activity.run?.status ?? activity.invocation?.status ?? "unknown";
}
function activityStartedAt(activity: SnapshotActivity): string {
  return activity.invocation?.startedAt ?? activity.run?.startedAt ?? activity.run?.createdAt ?? activity.at;
}

export function projectLoopMonitorSnapshot(snapshot: LoopMonitorSnapshot): {
  loops: LoopProjection[];
  runs: RunProjection[];
  canTombstone: boolean;
} {
  if (snapshot.schemaVersion !== 1) throw new Error(`Unsupported loop snapshot schemaVersion: ${snapshot.schemaVersion}`);
  assertTimestamp(snapshot.generatedAt, "generatedAt");
  if (!Array.isArray(snapshot.contracts) || !Array.isArray(snapshot.workflows)) throw new Error("Invalid loop snapshot shape");

  const workflowById = new Map(snapshot.workflows.map((workflow) => [workflow.id, workflow]));
  const loops: LoopProjection[] = [];
  const runs: RunProjection[] = [];
  const loopIds = new Set<string>();
  const activityIds = new Set<string>();

  for (const contract of snapshot.contracts) {
    if (!contract.id || loopIds.has(contract.id)) throw new Error(`Duplicate or empty contract id: ${contract.id}`);
    loopIds.add(contract.id);
    const workflow = workflowById.get(contract.workflowId);
    const activities = Array.isArray(contract.activities) ? contract.activities : [];
    const latestActivityAt = activities.map((activity) => activity.at).filter(Boolean).sort().at(-1) ?? null;
    const lastSuccessAt = activities
      .filter((activity) => activity.run?.status === "succeeded")
      .map((activity) => activity.run?.finishedAt ?? activity.run?.startedAt ?? activity.at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    const errors = (contract.errors ?? []).map((error) => `${error.code}: ${error.message}`).join("\n") || null;

    loops.push({
      id: contract.id,
      name: contract.name || contract.id,
      workflow_id: contract.workflowId,
      workflow_name: workflow?.name ?? contract.workflowId,
      lifecycle: contract.lifecycle,
      operation: contract.operation,
      role: contract.role,
      trigger_type: contract.trigger,
      owner_app: contract.ownerApp,
      objective: contract.objective ?? null,
      mode: contract.mode ?? null,
      definition_path: contract.path,
      definition_hash: contract.definitionHash,
      registry_hash: snapshot.registry.sha256,
      current_status: contract.state.rawStatus,
      current_reason: contract.state.reason,
      current_disposition: contract.state.disposition,
      is_blocked: contract.state.rawStatus === "blocked",
      needs_attention: contract.needsAttention.value,
      attention_reason: contract.needsAttention.code,
      latest_run_id: contract.latestRun?.id ?? null,
      latest_invocation_id: contract.latestInvocation?.id ?? null,
      last_activity_at: latestActivityAt,
      last_success_at: lastSuccessAt,
      lease_owner: contract.lease?.owner ?? null,
      lease_expires_at: contract.lease?.expiresAt ?? null,
      lease_stale: contract.lease?.stale ?? false,
      approval_required: contract.approval.required,
      output_exists: contract.output.latestExists,
      output_path: null,
      schedule_owner: contract.scheduler.owner,
      latest_scheduled_at: contract.latestScheduledInvocationAt ?? null,
      scheduler_health: contract.scheduler.health,
      observation_error: errors,
      source_schema_version: snapshot.schemaVersion,
      observed_at: snapshot.generatedAt,
    });

    for (const activity of activities) {
      if (!activity.id || activityIds.has(activity.id)) throw new Error(`Duplicate or empty activity id: ${activity.id}`);
      activityIds.add(activity.id);
      const status = activityStatus(activity);
      const startedAt = activityStartedAt(activity);
      runs.push({
        id: activity.id,
        activity_name: `${contract.name || contract.id} · ${status} · ${startedAt}`,
        loop_id: contract.id,
        invocation_id: activity.invocation?.id ?? null,
        run_id: activity.run?.id ?? activity.invocation?.runId ?? null,
        trigger_key_hash: activity.invocation?.triggerKeyHash ?? activity.run?.triggerKeyHash ?? null,
        occurrence_key_hash: activity.invocation?.occurrenceHash ?? null,
        origin: activity.invocation?.origin ?? "legacy",
        kind: activity.invocation?.kind ?? "legacy_run",
        status,
        reason: activity.run?.reason ?? activity.invocation?.reason ?? null,
        disposition: activity.invocation?.disposition ?? null,
        blocker: compactBlocker(activity.invocation?.blocker),
        approval_required: contract.approval.required && status === "waiting",
        output_path: null,
        started_at: startedAt,
        finished_at: activity.invocation?.finishedAt ?? activity.run?.finishedAt ?? null,
        duration_ms: activity.invocation?.durationMs ?? null,
        langfuse_trace_id: null,
        agent_session_id: null,
        source_schema_version: snapshot.schemaVersion,
        observed_at: snapshot.generatedAt,
        created_at: activity.run?.createdAt ?? startedAt,
      });
    }
  }

  return { loops, runs, canTombstone: snapshot.errors.length === 0 && loops.length > 0 };
}

const LOOP_COLUMNS = [
  "id", "name", "workflow_id", "workflow_name", "lifecycle", "operation", "role", "trigger_type", "owner_app",
  "objective", "mode", "definition_path", "definition_hash", "registry_hash", "current_status", "current_reason",
  "current_disposition", "is_blocked", "needs_attention", "attention_reason", "latest_run_id", "latest_invocation_id",
  "last_activity_at", "last_success_at", "lease_owner", "lease_expires_at", "lease_stale", "approval_required",
  "output_exists", "output_path", "schedule_owner", "latest_scheduled_at", "scheduler_health", "observation_error", "source_schema_version", "observed_at",
];
const RUN_COLUMNS = [
  "id", "activity_name", "loop_id", "invocation_id", "run_id", "trigger_key_hash", "occurrence_key_hash", "origin", "kind", "status",
  "reason", "disposition", "blocker", "approval_required", "output_path", "started_at", "finished_at", "duration_ms",
  "langfuse_trace_id", "agent_session_id", "source_schema_version", "observed_at", "created_at",
];

function recordsetSql(table: string, columns: string[], types: Record<string, string>): string {
  const definition = columns.map((column) => `${column} ${types[column] ?? "text"}`).join(", ");
  const updates = columns
    .filter((column) => !["id", "created_at"].includes(column))
    .map((column) => `${column}=excluded.${column}`)
    .join(", ");
  const clearTombstone = table === "automation_loops" ? ", tombstoned_at=null" : "";
  return `insert into ${table} (${columns.join(", ")}) select ${columns.join(", ")} from jsonb_to_recordset($1::jsonb) as x(${definition}) on conflict (id) do update set ${updates}, updated_at=now()${clearTombstone} where ${table}.observed_at <= excluded.observed_at`;
}

const TYPES: Record<string, string> = {
  is_blocked: "boolean", needs_attention: "boolean", lease_stale: "boolean", approval_required: "boolean", output_exists: "boolean",
  source_schema_version: "integer", duration_ms: "bigint", last_activity_at: "timestamptz", last_success_at: "timestamptz", latest_scheduled_at: "timestamptz",
  lease_expires_at: "timestamptz", observed_at: "timestamptz", started_at: "timestamptz", finished_at: "timestamptz", created_at: "timestamptz",
};

export async function importLoopMonitorSnapshot(snapshot: LoopMonitorSnapshot): Promise<{ loops: number; runs: number; tombstoned: boolean }> {
  const projection = projectLoopMonitorSnapshot(snapshot);
  await withPgTransaction(async (tx) => {
    if (projection.loops.length > 0) await tx.query(recordsetSql("automation_loops", LOOP_COLUMNS, TYPES), [JSON.stringify(projection.loops)]);
    if (projection.runs.length > 0) await tx.query(recordsetSql("automation_loop_runs", RUN_COLUMNS, TYPES), [JSON.stringify(projection.runs)]);
    if (projection.canTombstone) {
      await tx.query(
        "update automation_loops set tombstoned_at=$1::timestamptz, updated_at=now() where tombstoned_at is null and observed_at <= $1::timestamptz and not (id = any($2::text[]))",
        [snapshot.generatedAt, projection.loops.map((loop) => loop.id)],
      );
    }
  });
  return { loops: projection.loops.length, runs: projection.runs.length, tombstoned: projection.canTombstone };
}
