import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryPg } from "../lib/postgres";

async function main() {
  const sql = readFileSync(join(process.cwd(), "lib/crm-postgres/schema.sql"), "utf-8");
  await queryPg(sql);
  console.log("Applied CRM Postgres schema");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
