// PROTOTYPE ONLY. Never defaults to the production DenchClaw database.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const url = process.env.PROJECTS_MVP_DATABASE_URL;
if (!url)
  throw new Error(
    "Set PROJECTS_MVP_DATABASE_URL to a scratch/test Postgres URL; refusing production defaults.",
  );
const databaseName = new URL(url).pathname.replace(/^\//, "");
if (!databaseName || databaseName === "denchclaw") {
  throw new Error(
    "PROJECTS_MVP_DATABASE_URL must name a scratch database, never the production denchclaw database.",
  );
}

const schema = fileURLToPath(
  new URL("../../apps/web/lib/crm-postgres/schema.sql", import.meta.url),
);
const fixture = fileURLToPath(new URL("./projects-mvp-fixture.sql", import.meta.url));
for (const file of [schema, fixture]) {
  const result = spawnSync("psql", [url, "-X", "-v", "ON_ERROR_STOP=1", "-f", file], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`psql failed for ${file} with status ${result.status}`);
}
const check = spawnSync(
  "psql",
  [
    url,
    "-X",
    "-A",
    "-t",
    "-F",
    ",",
    "-c",
    "select (select count(*) from projects where id = 'reb-project-supplier-inventory'), (select count(*) from work_tasks where project_id = 'reb-project-supplier-inventory')",
  ],
  { encoding: "utf8" },
);
if (check.error) throw check.error;
if (check.status !== 0)
  throw new Error(check.stderr || `cardinality query failed with status ${check.status}`);
if (check.stdout.trim() !== "1,8")
  throw new Error(`fixture cardinality failed: ${check.stdout.trim()}`);
console.log(
  "PROJECTS MVP PROTOTYPE OK: 1 project, 8 tasks (Kanban Status; relation labels from projects.name)",
);
