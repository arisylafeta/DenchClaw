import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pgPool, queryPg } from "../lib/postgres";

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const postgresDir = join(moduleDir, "..", "lib", "crm-postgres");
  // This is a fresh-database bootstrap, not a migration replayer. Reapplying the
  // base schema after mail cutover would recreate retired tables and views.
  const [state] = await queryPg<{ existing: string | null }>(
    "select to_regclass('public.crm_objects')::text as existing",
  );
  if (state?.existing) {
    throw new Error("CRM database already exists; apply only explicitly approved new migrations.");
  }
  const sql = readFileSync(join(postgresDir, "schema.sql"), "utf-8");
  await queryPg(sql);
  const migrationsDir = join(postgresDir, "migrations");
  for (const migration of readdirSync(migrationsDir)
    .filter((filename) => filename.endsWith(".sql"))
    .sort()) {
    await queryPg(
      readFileSync(join(migrationsDir, migration), "utf-8"),
    );
  }
  console.log("Applied CRM Postgres schema and migrations");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgPool.end());
