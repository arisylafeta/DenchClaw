// PROTOTYPE ONLY. Never defaults to the production DenchClaw database.
import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.PROJECTS_MVP_DATABASE_URL;
if (!url) throw new Error("Set PROJECTS_MVP_DATABASE_URL to a scratch/test Postgres URL; refusing production defaults.");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(await readFile(new URL("../../apps/web/lib/crm-postgres/schema.sql", import.meta.url), "utf8"));
  await client.query(await readFile(new URL("./projects-mvp-fixture.sql", import.meta.url), "utf8"));
  const { rows } = await client.query("select (select count(*) from projects where id = 'reb-project-supplier-inventory')::int as projects, (select count(*) from work_tasks where project_id = 'reb-project-supplier-inventory')::int as tasks");
  if (rows[0].projects !== 1 || rows[0].tasks !== 8) throw new Error(`fixture cardinality failed: ${JSON.stringify(rows[0])}`);
  console.log("PROJECTS MVP PROTOTYPE OK: 1 project, 8 tasks (Kanban Status; relation labels from projects.name)");
} finally { await client.end(); }
