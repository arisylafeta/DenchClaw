import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.LOOP_MONITOR_DATABASE_URL;
if (!databaseUrl) throw new Error("Set LOOP_MONITOR_DATABASE_URL to an explicit Postgres URL.");
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
const productionApproved = process.env.LOOP_MONITOR_ALLOW_PRODUCTION === "approved-after-backup";
if (!databaseName || (databaseName === "denchclaw" && !productionApproved)) {
  throw new Error("Production setup requires LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup.");
}

// The canonical database must already be provisioned. Replaying the historical
// base schema here would recreate mail tables retired by migration 038.
const ready = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-c",
  "do $$ begin if to_regclass('automation_loops') is null or to_regclass('automation_loop_runs') is null then raise exception 'Provision the CRM database before loop setup'; end if; end $$;"], {
  stdio: "inherit",
});
if (ready.error) throw ready.error;
if (ready.status !== 0) throw new Error("CRM database is not provisioned.");
const objects = fileURLToPath(new URL("./loop-monitor-objects.sql", import.meta.url));
for (const file of [objects]) {
  const result = spawnSync("psql", [databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-f", file], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed for ${file} with status ${result.status}`);
}
console.log("Loop monitoring tables are ready; CRM loop pages remain retired.");
