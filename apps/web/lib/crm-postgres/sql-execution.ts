import { queryPg } from "@/lib/postgres";

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE)\b/i;
const BLOCKED_PATTERN = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|ANALYZE|ATTACH|DETACH|COPY|EXPORT|INSTALL|LOAD|PRAGMA|\.)\b/i;

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
  if (!READ_ONLY_PATTERN.test(sql) || BLOCKED_PATTERN.test(sql)) {
    throw new Error("Only read-only queries are allowed");
  }

  return await queryPg<Record<string, unknown>>(sql);
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
       and table_name like 'crm\\_%' escape '\\'
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
