import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLoopMonitorWorkspace } from "./loop-monitor-workspace.mjs";

const databaseUrl = process.env.LOOP_MONITOR_DATABASE_URL;
if (!databaseUrl) throw new Error("Set LOOP_MONITOR_DATABASE_URL to an explicit Postgres URL.");
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
const productionApproved = process.env.LOOP_MONITOR_ALLOW_PRODUCTION === "approved-after-backup";
if (!databaseName || (databaseName === "denchclaw" && !productionApproved)) {
  throw new Error("Production setup requires LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup.");
}

const workspaceInput = process.env.LOOP_MONITOR_WORKSPACE_ROOT;
if (!workspaceInput) throw new Error("Set LOOP_MONITOR_WORKSPACE_ROOT explicitly.");
const workspaceRoot = resolve(workspaceInput);
if (!existsSync(workspaceRoot) || lstatSync(workspaceRoot).isSymbolicLink()) {
  throw new Error("LOOP_MONITOR_WORKSPACE_ROOT must be an existing real directory.");
}
const canonicalWorkspace = realpathSync(workspaceRoot);
const productionWorkspace = realpathSync(resolve(process.env.HOME ?? "/root", ".hermes/workspace"));
if (canonicalWorkspace === productionWorkspace && !productionApproved) {
  throw new Error("Production workspace setup requires approval after backup.");
}

const schema = fileURLToPath(
  new URL("../../apps/web/lib/crm-postgres/schema.sql", import.meta.url),
);
const objects = fileURLToPath(new URL("./loop-monitor-objects.sql", import.meta.url));
for (const file of [schema, objects]) {
  const result = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f", file], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed for ${file} with status ${result.status}`);
}
writeLoopMonitorWorkspace(canonicalWorkspace, 0, 0);
console.log("Loop monitoring schema and workspace objects are ready.");
