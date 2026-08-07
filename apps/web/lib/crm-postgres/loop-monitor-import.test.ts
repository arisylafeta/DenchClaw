import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopMonitorSnapshot } from "./loop-monitor-import";

const withPgTransaction = vi.fn();
vi.mock("../postgres", () => ({ withPgTransaction }));

const baseSnapshot: LoopMonitorSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-08-07T20:00:00.000Z",
  registry: { path: "automations.yaml", version: 1, sha256: "registry-hash" },
  workflows: [{ id: "weekly", name: "Weekly editorial", operation: "scheduled", schedulerOwner: "Weekly job", contractIds: ["topics"] }],
  contracts: [{
    id: "topics",
    name: "Weekly topic proposals",
    path: "apps/weekly/loops/topics",
    workflowId: "weekly",
    ownerApp: "weekly",
    lifecycle: "active",
    operation: "scheduled",
    role: "entrypoint",
    trigger: "scheduler",
    definitionHash: "definition-hash",
    state: { rawStatus: "waiting", reason: "human_approval_required", disposition: "action_required" },
    needsAttention: { value: true, code: "approval_waiting", since: "2026-08-07T19:00:00.000Z" },
    approval: { required: true, pending: true, attentionAfterSeconds: 300 },
    output: { configured: true, latestExists: true },
    scheduler: { owner: "Weekly job", health: "unavailable" },
    lease: null,
    latestRun: { id: "run-1", triggerKeyHash: "trigger-hash", status: "waiting", reason: "human_approval_required", createdAt: "2026-08-07T19:00:00.000Z", startedAt: "2026-08-07T19:00:00.000Z", finishedAt: null, approvedAt: null, outputExists: true },
    latestInvocation: { id: "inv-1", runId: "run-1", triggerKeyHash: "trigger-hash", origin: "scheduler", kind: "run", status: "waiting", reason: "human_approval_required", startedAt: "2026-08-07T19:00:00.000Z", finishedAt: null, durationMs: 1200, occurrenceHash: "occurrence-hash", disposition: "action_required" },
    activities: [{ id: "inv-1", type: "invocation", at: "2026-08-07T19:00:00.000Z", invocation: { id: "inv-1", runId: "run-1", triggerKeyHash: "trigger-hash", origin: "scheduler", kind: "run", status: "waiting", reason: "human_approval_required", startedAt: "2026-08-07T19:00:00.000Z", finishedAt: null, durationMs: 1200, occurrenceHash: "occurrence-hash", disposition: "action_required" }, run: { id: "run-1", triggerKeyHash: "trigger-hash", status: "waiting", reason: "human_approval_required", createdAt: "2026-08-07T19:00:00.000Z", startedAt: "2026-08-07T19:00:00.000Z", finishedAt: null, approvedAt: null, outputExists: true } }],
    errors: [],
  }],
  errors: [],
};

describe("loop monitor snapshot projection", () => {
  beforeEach(() => vi.resetAllMocks());

  it("keeps approval waiting separate from blocked", async () => {
    const { projectLoopMonitorSnapshot } = await import("./loop-monitor-import");
    const result = projectLoopMonitorSnapshot(baseSnapshot);

    expect(result.loops[0]).toMatchObject({
      id: "topics",
      current_status: "waiting",
      needs_attention: true,
      attention_reason: "approval_waiting",
      is_blocked: false,
    });
    expect(result.runs[0]).toMatchObject({
      id: "inv-1",
      loop_id: "topics",
      status: "waiting",
      origin: "scheduler",
      approval_required: true,
      trigger_key_hash: "trigger-hash",
    });
  });

  it("marks only an explicit blocked runtime state as blocked", async () => {
    const { projectLoopMonitorSnapshot } = await import("./loop-monitor-import");
    const snapshot = structuredClone(baseSnapshot);
    snapshot.contracts[0].state.rawStatus = "blocked";
    snapshot.contracts[0].needsAttention.code = "run_blocked";
    const result = projectLoopMonitorSnapshot(snapshot);
    expect(result.loops[0]).toMatchObject({ is_blocked: true, needs_attention: true, current_status: "blocked" });
  });

  it("preserves deterministic legacy activity identifiers", async () => {
    const { projectLoopMonitorSnapshot } = await import("./loop-monitor-import");
    const snapshot = structuredClone(baseSnapshot);
    snapshot.contracts[0].activities = [{
      id: "run:legacy-1",
      type: "legacy_run",
      at: "2026-08-06T10:00:00.000Z",
      invocation: null,
      run: { id: "legacy-1", triggerKeyHash: "legacy:1", status: "succeeded", reason: "verified", createdAt: "2026-08-06T10:00:00.000Z", startedAt: null, finishedAt: "2026-08-06T10:02:00.000Z", approvedAt: null, outputExists: true },
    }];
    const result = projectLoopMonitorSnapshot(snapshot);
    expect(result.runs[0]).toMatchObject({ id: "run:legacy-1", run_id: "legacy-1", origin: "legacy", status: "succeeded" });
  });

  it("upserts projections and tombstones missing contracts without deleting history", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    withPgTransaction.mockImplementation(async (fn) => fn({ query }));
    const { importLoopMonitorSnapshot } = await import("./loop-monitor-import");
    const result = await importLoopMonitorSnapshot(baseSnapshot);

    expect(result).toEqual({ loops: 1, runs: 1, tombstoned: true });
    expect(query).toHaveBeenCalledTimes(3);
    expect(String(query.mock.calls[0][0])).toContain("insert into automation_loops");
    expect(String(query.mock.calls[0][0])).toContain("tombstoned_at=null");
    expect(String(query.mock.calls[0][0])).toContain("automation_loops.observed_at <= excluded.observed_at");
    expect(String(query.mock.calls[1][0])).toContain("insert into automation_loop_runs");
    expect(String(query.mock.calls[2][0])).toContain("tombstoned_at");
    expect(String(query.mock.calls[2][0])).toContain("observed_at <= $1::timestamptz");
    expect(query.mock.calls.some(([sql]) => /delete from/i.test(String(sql)))).toBe(false);
  });

  it("refuses unknown snapshot schemas", async () => {
    const { projectLoopMonitorSnapshot } = await import("./loop-monitor-import");
    expect(() => projectLoopMonitorSnapshot({ ...baseSnapshot, schemaVersion: 2 })).toThrow("Unsupported loop snapshot");
  });
});
