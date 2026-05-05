import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";

export type PostgresObjectRow = {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  default_view?: string | null;
  display_field?: string | null;
  immutable?: boolean | null;
  hidden_in_sidebar?: boolean | null;
  sort_order?: number | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  entity_table?: string | null;
};

export type PostgresFieldRow = {
  id: string;
  object_id: string;
  name: string;
  type: string;
  canonical_column?: string | null;
  description?: string | null;
  required?: boolean | null;
  enum_values?: unknown;
  enum_colors?: unknown;
  enum_multiple?: boolean | null;
  related_object_id?: string | null;
  relationship_type?: string | null;
  sort_order?: number | null;
};

export type PostgresStatusRow = {
  id: string;
  object_id: string;
  name: string;
  color?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
};

type CreatePostgresObjectInput = {
  id?: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  defaultView?: string;
  displayField?: string | null;
  immutable?: boolean;
  hiddenInSidebar?: boolean;
  sortOrder?: number;
  entityTable?: string | null;
  parentPath?: string;
};

async function txQuery<T extends Record<string, unknown>>(
  tx: PgTransaction,
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await tx.query(sql, [...params]);
  return Array.isArray(result) ? (result as T[]) : (result.rows as T[]);
}

export async function getPostgresObjectByName(name: string): Promise<PostgresObjectRow | null> {
  const rows = await queryPg<PostgresObjectRow>(
    `select id, name, description, icon, default_view, display_field, immutable, hidden_in_sidebar, sort_order, created_at, updated_at, entity_table
     from crm_objects
     where name = $1
     limit 1`,
    [name],
  );
  return rows[0] ?? null;
}

export async function getPostgresFields(objectId: string): Promise<PostgresFieldRow[]> {
  return queryPg<PostgresFieldRow>(
    `select id, object_id, name, type, canonical_column, description, required, enum_values, enum_colors, enum_multiple, related_object_id, relationship_type, sort_order
     from crm_fields
     where object_id = $1
     order by sort_order`,
    [objectId],
  );
}

export async function getPostgresStatuses(objectId: string): Promise<PostgresStatusRow[]> {
  return queryPg<PostgresStatusRow>(
    `select id, object_id, name, color, sort_order, is_default, created_at, updated_at
     from crm_statuses
     where object_id = $1
     order by sort_order`,
    [objectId],
  );
}

export function resolvePostgresDisplayField(
  object: Pick<PostgresObjectRow, "display_field">,
  fields: Array<Pick<PostgresFieldRow, "name" | "type">>,
): string {
  if (object.display_field) return object.display_field;
  const nameLike = fields.find((field) => /name|title/i.test(field.name));
  if (nameLike) return nameLike.name;
  const textField = fields.find((field) => field.type === "text");
  if (textField) return textField.name;
  return fields[0]?.name ?? "id";
}

export async function createPostgresObject(input: CreatePostgresObjectInput): Promise<{ ok: true; id: string; name: string; path: string }> {
  const id = input.id ?? randomUUID();
  const rows = await withPgTransaction(async (tx) => txQuery<{ id: string; name: string }>(
    tx,
    `insert into crm_objects
      (id, name, description, icon, default_view, display_field, immutable, hidden_in_sidebar, sort_order, entity_table)
     values
      ($1, $2, $3, $4, coalesce($5, 'table'), $6, coalesce($7, false), coalesce($8, false), coalesce($9, 0), $10)
     returning id, name`,
    [
      id,
      input.name,
      input.description ?? null,
      input.icon ?? null,
      input.defaultView ?? null,
      input.displayField ?? null,
      input.immutable ?? false,
      input.hiddenInSidebar ?? false,
      input.sortOrder ?? 0,
      input.entityTable ?? null,
    ],
  ));

  const row = rows[0];
  const path = input.parentPath ? `${input.parentPath}/${input.name}` : input.name;
  return { ok: true, id: row?.id ?? id, name: row?.name ?? input.name, path };
}

export async function updatePostgresDisplayField(objectName: string, displayField: string): Promise<{ ok: true; displayField: string }> {
  const object = await getPostgresObjectByName(objectName);
  if (!object) throw new Error(`Object not found: ${objectName}`);

  const fields = await queryPg<Pick<PostgresFieldRow, "id" | "name">>(
    `select id, name
     from crm_fields
     where object_id = $1 and name = $2
     limit 1`,
    [object.id, displayField],
  );
  if (!fields[0]) throw new Error(`Field not found on ${objectName}: ${displayField}`);

  await queryPg(
    `update crm_objects
     set display_field = $1, updated_at = now()
     where id = $2`,
    [displayField, object.id],
  );

  return { ok: true, displayField };
}

export async function reorderPostgresFields(objectName: string, fieldOrder: string[]): Promise<{ ok: true }> {
  await withPgTransaction(async (tx) => {
    const objects = await txQuery<{ id: string; name: string }>(
      tx,
      "select id, name from crm_objects where name = $1 limit 1",
      [objectName],
    );
    const object = objects[0];
    if (!object) throw new Error(`Object not found: ${objectName}`);

    for (const [index, fieldId] of fieldOrder.entries()) {
      await txQuery(
        tx,
        `update crm_fields
         set sort_order = $1, updated_at = now()
         where object_id = $2 and id = $3`,
        [index, object.id, fieldId],
      );
    }
  });

  return { ok: true };
}
