import { ALLOWED_EMAILS, hashPassword } from "../lib/auth";
import { withPgTransaction } from "../lib/postgres";

const USERS = [
  { email: "ari@rebattery.io", displayName: "Ari" },
  { email: "alex@rebattery.io", displayName: "Alex" },
] as const;

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
  const password = process.env.CRM_BOOTSTRAP_PASSWORD;
  if (!password) {
    throw new Error(
      "CRM_BOOTSTRAP_PASSWORD must be injected at runtime and is never persisted by this script",
    );
  }
  if (password.length < 12 || password.length > 1024) {
    throw new Error(
      "CRM_BOOTSTRAP_PASSWORD must be between 12 and 1024 characters",
    );
  }
  if (USERS.some((user) => !ALLOWED_EMAILS.has(user.email))) {
    throw new Error("bootstrap users must match the authentication allowlist");
  }

  const passwordHash = await hashPassword(password);
  await withPgTransaction(async (tx) => {
    for (const user of USERS) {
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
        [user.email, user.displayName, passwordHash],
      );
    }

    const placeholders = ACTIONABLE_ASSIGNMENTS.map(
      (_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`,
    ).join(", ");
    const parameters = ACTIONABLE_ASSIGNMENTS.flatMap(([rebKey, email]) => [
      rebKey,
      email,
    ]);
    const result = await tx.query(
      `update work_tasks task
          set assignee_id = crm_user.id
         from (values ${placeholders}) as assignment(reb_key, email)
         join crm_users crm_user on crm_user.email = assignment.email and crm_user.is_active
        where task.reb_key = assignment.reb_key
          and task.status in ('Planned', 'In Progress')`,
      parameters,
    );
    if (result.rowCount !== ACTIONABLE_ASSIGNMENTS.length) {
      throw new Error(
        `expected ${ACTIONABLE_ASSIGNMENTS.length} actionable Work Tasks, assigned ${result.rowCount ?? 0}`,
      );
    }
  });

  console.log(
    `Bootstrapped ${USERS.length} allowlisted CRM users and assigned ${ACTIONABLE_ASSIGNMENTS.length} actionable Work Tasks`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "bootstrap failed");
  process.exit(1);
});
