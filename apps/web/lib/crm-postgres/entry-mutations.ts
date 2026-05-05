import { randomUUID } from "node:crypto";
import { parseRelationIds, relationStorageValue, toCustomValueColumns } from "./value-codec";
import { withPgTransaction, type PgTransaction } from "../postgres";

type ObjectRow = { id: string; name: string; entity_table?: string | null };
type FieldRow = {
  id: string;
  object_id: string;
  name: string;
  type: string;
  canonical_column?: string | null;
  relationship_type?: string | null;
};

type QueryLikeResult<T> = { rows?: T[]; rowCount?: number | null } | T[];

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function rowsFrom<T>(result: QueryLikeResult<T>): T[] {
  return Array.isArray(result) ? result : (result.rows ?? []);
}

function rowCountFrom<T>(result: QueryLikeResult<T>): number {
  if (Array.isArray(result)) return result.length;
  if (typeof result.rowCount === "number") return result.rowCount;
  return result.rows?.length ?? 0;
}

async function loadObjectAndFields(tx: PgTransaction, objectName: string): Promise<{ object: ObjectRow; fields: FieldRow[] }> {
  const objectRows = rowsFrom(await tx.query(
    `select id, name, entity_table
     from crm_objects
     where name = $1
     limit 1`,
    [objectName],
  ));
  const object = objectRows[0];
  if (!object) throw new Error(`Object not found: ${objectName}`);

  const fields = rowsFrom(await tx.query(
    `select id, object_id, name, type, canonical_column, relationship_type
     from crm_fields
     where object_id = $1`,
    [object.id],
  ));

  return { object, fields };
}

async function upsertCustomValue(
  tx: PgTransaction,
  objectId: string,
  entryId: string,
  field: FieldRow,
  value: unknown,
) {
  const encoded = toCustomValueColumns(field.type, value);
  await tx.query(
    `insert into crm_custom_field_values
      (object_id, entry_id, field_id, text_value, number_value, boolean_value, date_value, json_value)
     values
      ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (entry_id, field_id)
     do update set
      text_value = excluded.text_value,
      number_value = excluded.number_value,
      boolean_value = excluded.boolean_value,
      date_value = excluded.date_value,
      json_value = excluded.json_value,
      updated_at = now()`,
    [
      objectId,
      entryId,
      field.id,
      encoded.text_value,
      encoded.number_value,
      encoded.boolean_value,
      encoded.date_value,
      encoded.json_value,
    ],
  );
}

async function replaceRelationLinks(
  tx: PgTransaction,
  objectId: string,
  entryId: string,
  field: FieldRow,
  rawValue: unknown,
) {
  const relationIds = parseRelationIds(rawValue);
  await tx.query("delete from crm_relation_links where field_id = $1 and source_entry_id = $2", [field.id, entryId]);
  for (const [position, targetEntryId] of relationIds.entries()) {
    await tx.query(
      `insert into crm_relation_links
        (object_id, field_id, source_entry_id, target_entry_id, position)
       values
        ($1, $2, $3, $4, $5)`,
      [objectId, field.id, entryId, targetEntryId, position],
    );
  }

  await upsertCustomValue(tx, objectId, entryId, field, relationStorageValue(relationIds, field.relationship_type));
}

export async function createPostgresEntry(
  objectName: string,
  fields: Record<string, unknown>,
): Promise<{ entryId: string; ok: true }> {
  const entryId = randomUUID();
  await withPgTransaction(async (tx) => {
    const { object, fields: objectFields } = await loadObjectAndFields(tx, objectName);
    const fieldByName = new Map(objectFields.map((field) => [field.name, field]));

    const canonicalColumns: string[] = ["id"];
    const canonicalValues: unknown[] = [entryId];

    for (const [fieldName, value] of Object.entries(fields)) {
      const field = fieldByName.get(fieldName);
      if (!field) throw new Error(`Field not found on ${objectName}: ${fieldName}`);

      if (field.canonical_column) {
        canonicalColumns.push(field.canonical_column);
        canonicalValues.push(value);
      } else if (field.type === "relation") {
        await replaceRelationLinks(tx, object.id, entryId, field, value);
      } else {
        await upsertCustomValue(tx, object.id, entryId, field, value);
      }
    }

    if (object.entity_table) {
      const cols = canonicalColumns.map(quoteIdentifier).join(", ");
      const placeholders = canonicalValues.map((_, index) => `$${index + 1}`).join(", ");
      await tx.query(`insert into ${quoteIdentifier(object.entity_table)} (${cols}) values (${placeholders})`, canonicalValues);
    }
  });

  return { entryId, ok: true };
}

export async function updatePostgresEntry(
  objectName: string,
  entryId: string,
  fields: Record<string, unknown>,
): Promise<{ ok: true; updatedCount: number }> {
  const updatedCount = await withPgTransaction(async (tx) => {
    const { object, fields: objectFields } = await loadObjectAndFields(tx, objectName);
    const fieldByName = new Map(objectFields.map((field) => [field.name, field]));

    const canonicalAssignments: string[] = [];
    const canonicalValues: unknown[] = [];

    for (const [fieldName, value] of Object.entries(fields)) {
      const field = fieldByName.get(fieldName);
      if (!field) throw new Error(`Field not found on ${objectName}: ${fieldName}`);

      if (field.canonical_column) {
        canonicalAssignments.push(`${quoteIdentifier(field.canonical_column)} = $${canonicalValues.length + 1}`);
        canonicalValues.push(value);
      } else if (field.type === "relation") {
        await replaceRelationLinks(tx, object.id, entryId, field, value);
      } else {
        await upsertCustomValue(tx, object.id, entryId, field, value);
      }
    }

    let canonicalUpdated = 1;
    if (object.entity_table && canonicalAssignments.length > 0) {
      const result = await tx.query(
        `update ${quoteIdentifier(object.entity_table)}
         set ${canonicalAssignments.join(", ")}, updated_at = now()
         where id = $${canonicalValues.length + 1}`,
        [...canonicalValues, entryId],
      );
      canonicalUpdated = rowCountFrom(result);
      if (canonicalUpdated === 0) throw new Error(`Entry not found: ${entryId}`);
    }

    return canonicalUpdated;
  });

  return { ok: true, updatedCount };
}

export async function deletePostgresEntry(objectName: string, entryId: string): Promise<{ ok: true }> {
  await withPgTransaction(async (tx) => {
    const { object } = await loadObjectAndFields(tx, objectName);

    await tx.query("delete from crm_custom_field_values where object_id = $1 and entry_id = $2", [object.id, entryId]);
    await tx.query("delete from crm_relation_links where source_entry_id = $1", [entryId]);
    await tx.query("delete from crm_relation_links where target_entry_id = $1", [entryId]);
    await tx.query("delete from crm_documents where entry_id = $1", [entryId]);
    await tx.query("delete from crm_action_runs where entry_id = $1", [entryId]);

    if (object.entity_table) {
      await tx.query(`delete from ${quoteIdentifier(object.entity_table)} where id = $1`, [entryId]);
    }
  });

  return { ok: true };
}

export async function bulkDeletePostgresEntries(
  objectName: string,
  entryIds: string[],
): Promise<{ ok: true; deletedCount: number }> {
  if (entryIds.length === 0) return { ok: true, deletedCount: 0 };

  const deletedCount = await withPgTransaction(async (tx) => {
    const { object } = await loadObjectAndFields(tx, objectName);

    await tx.query("delete from crm_custom_field_values where object_id = $1 and entry_id = any($2::text[])", [object.id, entryIds]);
    await tx.query("delete from crm_relation_links where source_entry_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_relation_links where target_entry_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_documents where entry_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_action_runs where entry_id = any($1::text[])", [entryIds]);

    if (object.entity_table) {
      const result = await tx.query(`delete from ${quoteIdentifier(object.entity_table)} where id = any($1::text[]) returning id`, [entryIds]);
      return rowCountFrom(result);
    }

    return entryIds.length;
  });

  return { ok: true, deletedCount };
}
