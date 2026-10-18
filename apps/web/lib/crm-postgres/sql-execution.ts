import { queryPg, withPgTransaction } from "@/lib/postgres";

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE)\b/i;
const BLOCKED_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|ATTACH|DETACH|COPY|EXPORT|INSTALL|LOAD|PRAGMA|\.)\b/i;


const USER_SCOPED_TABLE_PATTERN =
  /(^|[^a-z0-9_])(mail_[a-z0-9_]+|crm_email_[a-z0-9_]+|crm_interactions|crm_relation_links|work_tasks)([^a-z0-9_]|$)/i;

export function referencesUserScopedData(sql: string): boolean {
  return USER_SCOPED_TABLE_PATTERN.test(sql);
}
export type IntrospectedTable = {
  table_name: string;
  column_count: number;
  estimated_row_count: number;
  columns: Array<{
    name: string;
    type: string;
    is_nullable: boolean;
  }>;
};

export async function postgresReadOnlyQuery(sql: string): Promise<Record<string, unknown>[]> {
  if (/U&["']/i.test(sql) || /\bset_config\s*\(/i.test(sql)) throw new Error("Role settings are not allowed in raw SQL");
  if (!READ_ONLY_PATTERN.test(sql) || BLOCKED_PATTERN.test(sql) || /\b(insert|update|delete|merge|drop|alter|create|truncate|copy|grant|revoke|call|do)\b/i.test(sql) || /;\s*\S/.test(sql.trim().replace(/;$/, ""))) {
    throw new Error("Only read-only queries are allowed");
  }

  if (referencesUserScopedData(sql)) {
    throw new Error("Raw SQL access to user-scoped CRM data is disabled");
  }
  return withPgTransaction(async client => {
    await client.query("set local role crm_web_sql");
    await client.query("set transaction read only");
    return (await client.query(sql)).rows;
  });
}

export async function introspectPostgresCrm(): Promise<IntrospectedTable[]> {
  const rows = await queryPg<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
  }>(
    `select table_name, column_name, data_type, is_nullable
     from information_schema.columns
     where table_schema = 'public'
       and (table_name like 'crm\\_%' escape '\\' or table_name like 'mail\\_%' escape '\\')
     order by table_name, ordinal_position`,
  );

  const tableMap = new Map<string, IntrospectedTable>();
  for (const row of rows) {
    if (!tableMap.has(row.table_name)) {
      tableMap.set(row.table_name, {
        table_name: row.table_name,
        column_count: 0,
        estimated_row_count: 0,
        columns: [],
      });
    }
    const table = tableMap.get(row.table_name)!;
    table.columns.push({
      name: row.column_name,
      type: row.data_type,
      is_nullable: row.is_nullable === "YES",
    });
    table.column_count = table.columns.length;
  }

  return [...tableMap.values()];
}
