import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryPg } from "../lib/postgres";

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const postgresDir = join(moduleDir, "..", "lib", "crm-postgres");
  const sql = readFileSync(join(postgresDir, "schema.sql"), "utf-8");
  await queryPg(sql);
  for (const migration of [
    "001_auth_assignee.sql",
    "002_user_data_isolation.sql",
    "003_stock_items.sql",
    "004_stock_commercial_fields.sql",
    "005_stock_enrichment_state.sql",
  ]) {
    await queryPg(
      readFileSync(join(postgresDir, "migrations", migration), "utf-8"),
    );
  }
  console.log("Applied CRM Postgres schema and migrations");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
