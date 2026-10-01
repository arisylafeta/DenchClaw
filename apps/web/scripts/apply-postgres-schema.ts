import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pgPool, queryPg } from "../lib/postgres";

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const postgresDir = join(moduleDir, "..", "lib", "crm-postgres");
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
