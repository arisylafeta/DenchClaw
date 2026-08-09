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
    users_table: string | null;
    sessions_table: string | null;
    assignee_column: string;
    assignee_field: string;
    user_name_field: string;
  }>(`
    select
      to_regclass('public.crm_users')::text as users_table,
      to_regclass('public.crm_sessions')::text as sessions_table,
      (select count(*)::text from information_schema.columns
        where table_schema = 'public' and table_name = 'work_tasks' and column_name = 'assignee_id') as assignee_column,
      (select count(*)::text from crm_fields f join crm_objects o on o.id = f.object_id
        where o.name = 'work_task' and f.name = 'Assignee' and f.canonical_column = 'assignee_id') as assignee_field,
      (select count(*)::text from crm_fields f join crm_objects o on o.id = f.object_id
        where o.name = 'crm_user' and f.name = 'Name' and f.canonical_column = 'display_name') as user_name_field
  `);
  const verification = rows[0];
  if (
    verification?.users_table !== "crm_users" ||
    verification.sessions_table !== "crm_sessions" ||
    verification.assignee_column !== "1" ||
    verification.assignee_field !== "1" ||
    verification.user_name_field !== "1"
  ) {
    throw new Error("auth/assignee migration verification failed");
  }
  console.log("Applied and verified auth/assignee migration");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "migration failed");
  process.exit(1);
});
