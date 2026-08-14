import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const databaseUrl = process.env.LOOP_MONITOR_DATABASE_URL;
if (!databaseUrl) throw new Error("Set LOOP_MONITOR_DATABASE_URL to an explicit Postgres URL.");
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "");
const productionApproved = process.env.LOOP_MONITOR_ALLOW_PRODUCTION === "approved-after-backup";
if (!databaseName || (databaseName === "denchclaw" && !productionApproved)) {
  throw new Error("Production setup requires LOOP_MONITOR_ALLOW_PRODUCTION=approved-after-backup.");
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
console.log("Loop monitoring tables are ready; CRM loop pages remain retired.");
