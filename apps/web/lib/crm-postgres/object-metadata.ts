import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction, type PgTransaction } from "../postgres";

export type PostgresObjectRow = {
  id: string;
  name: string;
  description?: string | null;
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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function assertPostgresObjectMutable(
  object: Pick<PostgresObjectRow, "name" | "immutable">,
): void {
  if (object.immutable) throw new Error(`Object '${object.name}' is read-only`);
}

export async function getPostgresObjectByName(name: string): Promise<PostgresObjectRow | null> {
  const rows = await queryPg<PostgresObjectRow>(
    `select id, name, description, default_view, display_field, immutable, hidden_in_sidebar, sort_order, created_at, updated_at, entity_table
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

export async function getPostgresStatuses(_objectId: string): Promise<PostgresStatusRow[]> {
  // crm_statuses table was dropped; statuses are no longer persisted.
  return [];
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
      (id, name, description, default_view, display_field, immutable, hidden_in_sidebar, sort_order, entity_table)
     values
      ($1, $2, $3, coalesce($4, 'table'), $5, coalesce($6, false), coalesce($7, false), coalesce($8, 0), $9)
     returning id, name`,
    [
      id,
      input.name,
      input.description ?? null,
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
  assertPostgresObjectMutable(object);

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
    const objects = await txQuery<{ id: string; name: string; immutable?: boolean | null }>(
      tx,
      "select id, name, immutable from crm_objects where name = $1 limit 1",
      [objectName],
    );
    const object = objects[0];
    if (!object) throw new Error(`Object not found: ${objectName}`);
    assertPostgresObjectMutable(object);

    const existingFields = await txQuery<{ id: string }>(
      tx,
      `select id
       from crm_fields
       where object_id = $1 and id = any($2::text[])`,
      [object.id, fieldOrder],
    );
    const existingIds = new Set(existingFields.map((field) => field.id));
    const missingIds = fieldOrder.filter((fieldId) => !existingIds.has(fieldId));
    if (missingIds.length > 0) {
      throw new Error(`Fields not found on ${objectName}: ${missingIds.join(", ")}`);
    }

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

export async function createPostgresField(
  objectName: string,
  body: { name?: string; type?: string; enum_values?: string[]; required?: boolean },
): Promise<{ ok: true; fieldId: string; name: string; type: string }> {
  const object = await getPostgresObjectByName(objectName);
  if (!object) throw new Error(`Object '${objectName}' not found`);
  assertPostgresObjectMutable(object);

  const fieldName = body.name?.trim();
  const fieldType = body.type?.trim();
  if (!fieldName) throw new Error("Field name is required");
  if (!fieldType) throw new Error("Field type is required");
  if (fieldType === "enum" && (!Array.isArray(body.enum_values) || body.enum_values.length === 0)) {
    throw new Error("enum_values required for enum fields");
  }

  const duplicate = await queryPg<{ cnt: number }>(
    `select count(*)::int as cnt
     from crm_fields
     where object_id = $1 and name = $2`,
    [object.id, fieldName],
  );
  if ((duplicate[0]?.cnt ?? 0) > 0) throw new Error("A field with that name already exists");

  const maxOrder = await queryPg<{ max_order: number | null }>(
    `select coalesce(max(sort_order), -1)::int as max_order
     from crm_fields
     where object_id = $1`,
    [object.id],
  );
  const sortOrder = (maxOrder[0]?.max_order ?? -1) + 1;
  const fieldId = randomUUID();

  const inserted = await queryPg<{ id: string; name: string; type: string }>(
    `insert into crm_fields (id, object_id, name, type, required, sort_order, enum_values)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     returning id, name, type`,
    [
      fieldId,
      object.id,
      fieldName,
      fieldType,
      body.required === true,
      sortOrder,
      fieldType === "enum" ? JSON.stringify(body.enum_values ?? []) : null,
    ],
  );

  return { ok: true, fieldId: inserted[0]?.id ?? fieldId, name: inserted[0]?.name ?? fieldName, type: inserted[0]?.type ?? fieldType };
}

export async function updatePostgresField(
  objectName: string,
  fieldId: string,
  body: { name?: string; enum_values?: string[] },
): Promise<{ ok: true }> {
  const object = await getPostgresObjectByName(objectName);
  if (!object) throw new Error(`Object '${objectName}' not found`);
  assertPostgresObjectMutable(object);

  const fields = await queryPg<{ id: string; object_id: string; type: string }>(
    `select id, object_id, type
     from crm_fields
     where id = $1 and object_id = $2
     limit 1`,
    [fieldId, object.id],
  );
  const field = fields[0];
  if (!field) throw new Error("Field not found");

  const updates: string[] = [];
  const params: unknown[] = [];

  if (typeof body.name === "string" && body.name.trim().length > 0) {
    const newName = body.name.trim();
    const duplicate = await queryPg<{ cnt: number }>(
      `select count(*)::int as cnt from crm_fields where object_id = $1 and name = $2 and id != $3`,
      [object.id, newName, fieldId],
    );
    if ((duplicate[0]?.cnt ?? 0) > 0) throw new Error("A field with that name already exists");
    params.push(newName);
    updates.push(`name = $${params.length}`);
  }

  if (Object.prototype.hasOwnProperty.call(body, "enum_values")) {
    if (field.type !== "enum") throw new Error("enum_values can only be updated for select fields");
    const enumValues = body.enum_values;
    if (!Array.isArray(enumValues)) throw new Error("enum_values must be an array of unique strings");
    params.push(JSON.stringify(enumValues));
    updates.push(`enum_values = $${params.length}::jsonb`);
  }

  if (updates.length === 0) throw new Error("Name or enum_values is required");

  params.push(fieldId, object.id);
  await queryPg(
    `update crm_fields
     set ${updates.join(", ")}, updated_at = now()
     where id = $${params.length - 1} and object_id = $${params.length}`,
    params,
  );

  return { ok: true };
}

export async function deletePostgresField(objectName: string, fieldId: string): Promise<{ ok: true }> {
  const object = await getPostgresObjectByName(objectName);
  if (!object) throw new Error(`Object '${objectName}' not found`);
  assertPostgresObjectMutable(object);

  const field = await queryPg<{ id: string }>(
    `select id from crm_fields where id = $1 and object_id = $2 limit 1`,
    [fieldId, object.id],
  );
  if (!field[0]) throw new Error("Field not found");

  await queryPg("delete from crm_fields where id = $1 and object_id = $2", [fieldId, object.id]);
  return { ok: true };
}

export async function renamePostgresEnumValue(
  objectName: string,
  fieldId: string,
  oldValue: string,
  newValue: string,
): Promise<{ ok: true; updated: boolean }> {
  const object = await getPostgresObjectByName(objectName);
  if (!object) throw new Error(`Object '${objectName}' not found`);
  assertPostgresObjectMutable(object);

  const fields = await queryPg<{ id: string; object_id: string; enum_values: unknown; canonical_column?: string | null }>(
    `select id, object_id, enum_values, canonical_column
     from crm_fields
     where id = $1 and object_id = $2
     limit 1`,
    [fieldId, object.id],
  );
  const field = fields[0];
  if (!field) throw new Error("Field not found");

  const oldTrim = oldValue.trim();
  const newTrim = newValue.trim();
  if (!oldTrim || !newTrim) throw new Error("oldValue and newValue are required");
  if (oldTrim === newTrim) return { ok: true, updated: false };

  const enumValuesRaw = field.enum_values;
  const enumValues = Array.isArray(enumValuesRaw)
    ? enumValuesRaw.filter((value): value is string => typeof value === "string")
    : typeof enumValuesRaw === "string"
      ? (() => {
        try {
          const parsed = JSON.parse(enumValuesRaw);
          return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
        } catch {
          return [];
        }
      })()
      : [];

  const idx = enumValues.indexOf(oldTrim);
  if (idx < 0) throw new Error(`Enum value '${oldValue}' not found`);
  if (enumValues.includes(newTrim)) throw new Error(`Enum value '${newValue}' already exists`);

  enumValues[idx] = newTrim;
  await queryPg(
    `update crm_fields set enum_values = $1::jsonb, updated_at = now() where id = $2 and object_id = $3`,
    [JSON.stringify(enumValues), fieldId, object.id],
  );

  if (field.canonical_column && object.entity_table) {
    await queryPg(
      `update ${quoteIdentifier(object.entity_table)} set ${quoteIdentifier(field.canonical_column)} = $1 where ${quoteIdentifier(field.canonical_column)} = $2`,
      [newTrim, oldTrim],
    );
  }

  return { ok: true, updated: true };
}
