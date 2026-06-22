import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { queryPg } from "../lib/postgres";

async function main() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(moduleDir, "..", "lib", "crm-postgres", "schema.sql"), "utf-8");
  await queryPg(sql);
  console.log("Applied CRM Postgres schema");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
