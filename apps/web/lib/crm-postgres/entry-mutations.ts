import { randomUUID } from "node:crypto";
import { parseRelationIds, relationStorageValue } from "./value-codec";
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

const canonicalTableByObjectName: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
};

// Objects exposed as read-only CRM tables (e.g. campaign metrics snapshots). Any
// create/update/delete is rejected up front so the UI cannot silently no-op or
// return a false-success response. Routes map the "read-only" message to HTTP 403.
const READ_ONLY_OBJECTS = new Set(["campaign", "campaigns"]);

function assertMutable(objectName: string): void {
  if (READ_ONLY_OBJECTS.has(objectName.trim().toLowerCase())) {
    throw new Error(`Object '${objectName}' is read-only.`);
  }
}

const JUNCTION_TABLE_MAP: Record<string, { table: string; sourceCol: string; targetCol: string; extraCols?: Record<string, string> }> = {
  "seed_fld_emthread_people_00000": { table: "crm_email_thread_participants", sourceCol: "thread_id", targetCol: "person_id" },
  "seed_fld_emmsg_to_0000000000000": { table: "crm_email_message_recipients", sourceCol: "message_id", targetCol: "person_id", extraCols: { recipient_type: "to" } },
  "seed_fld_emmsg_cc_0000000000000": { table: "crm_email_message_recipients", sourceCol: "message_id", targetCol: "person_id", extraCols: { recipient_type: "cc" } },
  "seed_fld_calev_attend_000000000": { table: "crm_calendar_event_attendees", sourceCol: "event_id", targetCol: "person_id" },
};

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

function resolveEntityTable(object: Pick<ObjectRow, "name" | "entity_table">): string | null {
  if (object.entity_table) return object.entity_table;
  return canonicalTableByObjectName[object.name.trim().toLowerCase()] ?? null;
}

function normalizeRelationIds(ids: string[], relationshipType?: string | null): string[] {
  if (relationshipType === "many_to_many") return ids;
  return ids.length > 0 ? [ids[0]] : [];
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

async function replaceRelationLinks(
  tx: PgTransaction,
  objectId: string,
  entryId: string,
  field: FieldRow,
  relationIds: string[],
) {
  const junction = JUNCTION_TABLE_MAP[field.id];
  if (junction) {
    // Delete existing rows scoped by extraCols (e.g. recipient_type) to avoid
    // wiping sibling relations that share the same junction table (To vs Cc).
    if (junction.extraCols && junction.extraCols.recipient_type) {
      await tx.query(
        `delete from ${junction.table} where ${junction.sourceCol} = $1 and recipient_type = $2`,
        [entryId, junction.extraCols.recipient_type],
      );
    } else {
      await tx.query(`delete from ${junction.table} where ${junction.sourceCol} = $1`, [entryId]);
    }
    for (const [position, targetEntryId] of relationIds.entries()) {
      if (junction.extraCols && junction.extraCols.recipient_type) {
        await tx.query(
          `insert into ${junction.table} (${junction.sourceCol}, ${junction.targetCol}, recipient_type, position) values ($1, $2, $3, $4) on conflict do nothing`,
          [entryId, targetEntryId, junction.extraCols.recipient_type, position],
        );
      } else {
        await tx.query(
          `insert into ${junction.table} (${junction.sourceCol}, ${junction.targetCol}, position) values ($1, $2, $3) on conflict do nothing`,
          [entryId, targetEntryId, position],
        );
      }
    }
  }
  // For non-junction relations (many_to_one with canonical_column),
  // the canonical column write handles it — no relation_links needed.
}

async function entryExists(tx: PgTransaction, object: ObjectRow, entryId: string): Promise<boolean> {
  const entityTable = resolveEntityTable(object);
  if (entityTable) {
    const rows = rowsFrom(await tx.query(`select id from ${quoteIdentifier(entityTable)} where id = $1 limit 1`, [entryId]));
    return rows.length > 0;
  }
  return false;
}

export async function createPostgresEntry(
  objectName: string,
  fields: Record<string, unknown>,
): Promise<{ entryId: string; ok: true }> {
  assertMutable(objectName);
  const entryId = randomUUID();
  await withPgTransaction(async (tx) => {
    const { object, fields: objectFields } = await loadObjectAndFields(tx, objectName);
    const fieldByName = new Map(objectFields.map((field) => [field.name, field]));

    const canonicalColumns: string[] = ["id"];
    const canonicalValues: unknown[] = [entryId];

    for (const [fieldName, value] of Object.entries(fields)) {
      const field = fieldByName.get(fieldName);
      if (!field) throw new Error(`Field not found on ${objectName}: ${fieldName}`);

      const relationIds = field.type === "relation"
        ? normalizeRelationIds(parseRelationIds(value), field.relationship_type)
        : null;

      if (relationIds && !field.canonical_column) {
        await replaceRelationLinks(tx, object.id, entryId, field, relationIds);
      }

      if (field.canonical_column) {
        canonicalColumns.push(field.canonical_column);
        canonicalValues.push(relationIds ? relationStorageValue(relationIds, field.relationship_type) : value);
      } else if (field.type !== "relation") {
        throw new Error(`Non-canonical field "${fieldName}" on "${objectName}" has no column mapping. Add a real column and canonical_column to crm_fields.`);
      }
    }

    const entityTable = resolveEntityTable(object);
    if (entityTable) {
      const cols = canonicalColumns.map(quoteIdentifier).join(", ");
      const placeholders = canonicalValues.map((_, index) => `$${index + 1}`).join(", ");
      await tx.query(`insert into ${quoteIdentifier(entityTable)} (${cols}) values (${placeholders})`, canonicalValues);
    }
  });

  return { entryId, ok: true };
}

export async function updatePostgresEntry(
  objectName: string,
  entryId: string,
  fields: Record<string, unknown>,
): Promise<{ ok: true; updatedCount: number }> {
  assertMutable(objectName);
  const updatedCount = await withPgTransaction(async (tx) => {
    const { object, fields: objectFields } = await loadObjectAndFields(tx, objectName);
    const fieldByName = new Map(objectFields.map((field) => [field.name, field]));
    const entityTable = resolveEntityTable(object);

    if (!(await entryExists(tx, object, entryId))) {
      throw new Error(`Entry not found: ${entryId}`);
    }

    const canonicalAssignments: string[] = [];
    const canonicalValues: unknown[] = [];

    for (const [fieldName, value] of Object.entries(fields)) {
      const field = fieldByName.get(fieldName);
      if (!field) throw new Error(`Field not found on ${objectName}: ${fieldName}`);

      const relationIds = field.type === "relation"
        ? normalizeRelationIds(parseRelationIds(value), field.relationship_type)
        : null;

      if (relationIds && !field.canonical_column) {
        await replaceRelationLinks(tx, object.id, entryId, field, relationIds);
      }

      if (field.canonical_column) {
        canonicalAssignments.push(`${quoteIdentifier(field.canonical_column)} = $${canonicalValues.length + 1}`);
        canonicalValues.push(relationIds ? relationStorageValue(relationIds, field.relationship_type) : value);
      } else if (field.type !== "relation") {
        throw new Error(`Non-canonical field "${fieldName}" on "${objectName}" has no column mapping. Add a real column and canonical_column to crm_fields.`);
      }
    }

    let canonicalUpdated = 1;
    if (entityTable && canonicalAssignments.length > 0) {
      const result = await tx.query(
        `update ${quoteIdentifier(entityTable)}
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
  assertMutable(objectName);
  await withPgTransaction(async (tx) => {
    const { object } = await loadObjectAndFields(tx, objectName);
    const entityTable = resolveEntityTable(object);

    // Clean up junction table entries
    await tx.query("delete from crm_email_thread_participants where thread_id = $1 or person_id = $1", [entryId]);
    await tx.query("delete from crm_email_message_recipients where message_id = $1 or person_id = $1", [entryId]);
    await tx.query("delete from crm_calendar_event_attendees where event_id = $1 or person_id = $1", [entryId]);
    await tx.query("delete from crm_documents where entry_id = $1", [entryId]);

    if (entityTable) {
      await tx.query(`delete from ${quoteIdentifier(entityTable)} where id = $1`, [entryId]);
    }
  });

  return { ok: true };
}

export async function bulkDeletePostgresEntries(
  objectName: string,
  entryIds: string[],
): Promise<{ ok: true; deletedCount: number }> {
  assertMutable(objectName);
  if (entryIds.length === 0) return { ok: true, deletedCount: 0 };

  const deletedCount = await withPgTransaction(async (tx) => {
    const { object } = await loadObjectAndFields(tx, objectName);
    const entityTable = resolveEntityTable(object);

    // Clean up junction table entries
    await tx.query("delete from crm_email_thread_participants where thread_id = any($1::text[]) or person_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_email_message_recipients where message_id = any($1::text[]) or person_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_calendar_event_attendees where event_id = any($1::text[]) or person_id = any($1::text[])", [entryIds]);
    await tx.query("delete from crm_documents where entry_id = any($1::text[])", [entryIds]);

    if (entityTable) {
      const result = await tx.query(`delete from ${quoteIdentifier(entityTable)} where id = any($1::text[]) returning id`, [entryIds]);
      return rowCountFrom(result);
    }

    return entryIds.length;
  });

  return { ok: true, deletedCount };
}
