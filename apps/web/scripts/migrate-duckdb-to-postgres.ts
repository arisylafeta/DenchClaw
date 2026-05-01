import { applyMigration, buildMigrationPlan } from "../lib/crm-postgres/migrate-duckdb";

async function main() {
  if (process.argv.includes("--apply")) {
    const result = await applyMigration();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const plan = await buildMigrationPlan();
  console.log(JSON.stringify(plan, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
