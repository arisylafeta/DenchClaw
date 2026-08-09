import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queryPg } from "../lib/postgres";
async function main() {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "../lib/crm-postgres/migrations/001_auth_assignee.sql",
    ),
    "utf8",
  );
  await queryPg(sql);
  const rows = await queryPg<{
    users: string;
    sessions: string;
    assignee: string;
  }>(
    `select (select count(*)::text from crm_users) users,(select count(*)::text from crm_sessions) sessions,(select count(*)::text from information_schema.columns where table_name='work_tasks' and column_name='assignee_id') assignee`,
  );
  if (rows[0]?.assignee !== "1")
    throw new Error("assignee migration verification failed");
  console.log("Applied and verified auth/assignee migration");
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "migration failed");
  process.exit(1);
});
