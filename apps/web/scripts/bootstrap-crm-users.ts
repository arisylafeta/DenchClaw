import { ALLOWED_EMAILS, hashPassword } from "../lib/auth";
import { withPgTransaction } from "../lib/postgres";
import { hashCrmBootstrapUsers } from "../lib/crm-bootstrap";

const ACTIONABLE_ASSIGNMENTS = [
  ["REB-62", "alex@rebattery.io"],
  ["REB-76", "alex@rebattery.io"],
  ["REB-84", "alex@rebattery.io"],
  ["REB-104", "alex@rebattery.io"],
  ["REB-111", "alex@rebattery.io"],
  ["REB-115", "alex@rebattery.io"],
  ["REB-89", "ari@rebattery.io"],
  ["REB-93", "ari@rebattery.io"],
  ["REB-105", "ari@rebattery.io"],
  ["REB-108", "ari@rebattery.io"],
  ["REB-117", "ari@rebattery.io"],
  ["REB-118", "ari@rebattery.io"],
  ["REB-119", "ari@rebattery.io"],
  ["REB-121", "ari@rebattery.io"],
  ["REB-122", "ari@rebattery.io"],
  ["REB-123", "ari@rebattery.io"],
  ["REB-124", "ari@rebattery.io"],
] as const;

async function main() {
  const usersWithHashes = await hashCrmBootstrapUsers(hashPassword);
  if (usersWithHashes.some((user) => !ALLOWED_EMAILS.has(user.email))) {
    throw new Error("bootstrap users must match the authentication allowlist");
  }

  await withPgTransaction(async (tx) => {
    for (const user of usersWithHashes) {
      await tx.query(
        `insert into crm_users(email, display_name, password_hash)
         values($1, $2, $3)
         on conflict(email) do update
           set display_name = excluded.display_name,
               password_hash = excluded.password_hash,
               is_active = true,
               failed_login_count = 0,
               locked_until = null,
               updated_at = now()`,
        [user.email, user.displayName, user.passwordHash],
      );
    }

    const placeholders = ACTIONABLE_ASSIGNMENTS.map(
      (_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`,
    ).join(", ");
    const parameters = ACTIONABLE_ASSIGNMENTS.flatMap(([rebKey, email]) => [
      rebKey,
      email,
    ]);
    await tx.query(
      `update work_tasks task
          set assignee_id = crm_user.id
         from (values ${placeholders}) as assignment(reb_key, email)
         join crm_users crm_user on crm_user.email = assignment.email and crm_user.is_active
        where task.reb_key = assignment.reb_key
          and task.assignee_id is null
          and task.status in ('Planned', 'In Progress')`,
      parameters,
    );

    const legacyColumn = await tx.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'work_tasks'
            and column_name = 'assignee_email'
       ) as present`,
    );
    if (legacyColumn.rows[0]?.present) {
      await tx.query(
        `update work_tasks task
            set assignee_id = crm_user.id
           from crm_users crm_user
          where task.status in ('Planned', 'In Progress')
            and task.assignee_email is not null
            and lower(btrim(task.assignee_email)) = lower(crm_user.email)
            and crm_user.is_active
            and lower(crm_user.email) in ('ari@rebattery.io', 'alex@rebattery.io')`,
      );
    }
    await tx.query(
      `update work_tasks set assignee_id = null where status in ('Done', 'Retired')`,
    );
  });

  console.log(
    `Bootstrapped ${usersWithHashes.length} allowlisted CRM users and reconciled actionable Work Task assignments`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "bootstrap failed");
  process.exit(1);
});
