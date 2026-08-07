import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { importLoopMonitorSnapshot, type LoopMonitorSnapshot } from "../lib/crm-postgres/loop-monitor-import";
import { pgPool, queryPg } from "../lib/postgres";
import { writeLoopMonitorWorkspace } from "../../../scripts/rebattery/loop-monitor-workspace.mjs";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function loadSnapshot(): LoopMonitorSnapshot {
  const snapshotFile = argument("--snapshot-file");
  if (snapshotFile) return JSON.parse(readFileSync(resolve(snapshotFile), "utf8")) as LoopMonitorSnapshot;

  const repositoryRoot = process.env.LOOP_MONITOR_AUTOMATIONS_ROOT;
  if (!repositoryRoot) throw new Error("Set LOOP_MONITOR_AUTOMATIONS_ROOT or pass --snapshot-file.");
  const loopctl = process.env.LOOPCTL_BIN || "loopctl";
  const historyLimit = process.env.LOOP_MONITOR_HISTORY_LIMIT || "50";
  const result = spawnSync(loopctl, ["snapshot", resolve(repositoryRoot), "--history-limit", historyLimit, "--json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `loopctl snapshot failed with status ${result.status}`);
  return JSON.parse(result.stdout) as LoopMonitorSnapshot;
}

try {
  const workspaceRoot = process.env.LOOP_MONITOR_WORKSPACE_ROOT;
  if (!workspaceRoot) throw new Error("Set LOOP_MONITOR_WORKSPACE_ROOT explicitly.");
  const snapshot = loadSnapshot();
  const imported = await importLoopMonitorSnapshot(snapshot);
  const [loopCountRows, runCountRows] = await Promise.all([
    queryPg<{ count: string }>("select count(*)::text as count from automation_loops where tombstoned_at is null"),
    queryPg<{ count: string }>("select count(*)::text as count from automation_loop_runs"),
  ]);
  const loopCount = Number(loopCountRows[0]?.count ?? 0);
  const runCount = Number(runCountRows[0]?.count ?? 0);
  writeLoopMonitorWorkspace(workspaceRoot, loopCount, runCount);
  console.log(JSON.stringify({ ok: true, generatedAt: snapshot.generatedAt, imported, visibleLoops: loopCount, retainedRuns: runCount }));
} finally {
  await pgPool.end();
}
