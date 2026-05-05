import { queryPg } from "../postgres";

type SuggestItemLike = {
  name: string;
  path: string;
  type: "object" | "entry";
  icon?: string;
  defaultView?: "table" | "kanban";
  objectName?: string;
  entryId?: string;
};

type ObjectRow = {
  id: string;
  name: string;
  icon?: string | null;
  default_view?: string | null;
};

type FieldRow = {
  object_id: string;
  canonical_column?: string | null;
  type: string;
};

const OBJECT_TABLES: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
};

const FALLBACK_COLUMNS: Record<string, string[]> = {
  people: ["full_name", "email"],
  company: ["name", "domain", "website"],
  companies: ["name", "domain", "website"],
  email_thread: ["subject"],
  email_message: ["subject", "from_email", "to_email"],
  calendar_event: ["title", "location"],
  interaction: ["type", "notes"],
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

export async function searchPostgresObjects(query: string, max: number): Promise<SuggestItemLike[]> {
  const trimmed = query.trim();
  const rows = await queryPg<ObjectRow>(
    `select name, icon, default_view
       from crm_objects
      where hidden_in_sidebar = false
        and ($1 = '' or lower(name) like lower($2))
      order by sort_order, name
      limit $3`,
    [trimmed, `%${trimmed}%`, max],
  );
  return rows.map((row) => ({
    name: row.name,
    path: `workspace:object:${row.name}`,
    type: "object",
    icon: row.icon ?? undefined,
    defaultView: row.default_view === "kanban" ? "kanban" : "table",
  }));
}

export async function searchPostgresEntries(query: string, max: number): Promise<SuggestItemLike[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const objects = await queryPg<ObjectRow>(
    `select id, name, icon
       from crm_objects
      where hidden_in_sidebar = false
      order by sort_order, name`,
  );
  if (objects.length === 0) return [];

  const fields = await queryPg<FieldRow>(
    `select object_id, canonical_column, type
       from crm_fields
      where object_id = any($1::text[])`,
    [objects.map((obj) => obj.id)],
  );
  const fieldsByObject = new Map<string, FieldRow[]>();
  for (const row of fields) {
    const existing = fieldsByObject.get(row.object_id) ?? [];
    existing.push(row);
    fieldsByObject.set(row.object_id, existing);
  }

  const items: SuggestItemLike[] = [];
  for (const object of objects) {
    if (items.length >= max) break;
    const remaining = max - items.length;
    const seenEntryIds = new Set<string>();

    const tableName = OBJECT_TABLES[object.name];
    if (tableName) {
      const objectFields = fieldsByObject.get(object.id) ?? [];
      const searchableColumns = new Set<string>();
      for (const field of objectFields) {
        if (!field.canonical_column) continue;
        if (
          field.type === "text" ||
          field.type === "email" ||
          field.type === "url" ||
          field.type === "phone" ||
          /name|title|email/i.test(field.canonical_column)
        ) {
          searchableColumns.add(field.canonical_column);
        }
      }
      for (const col of FALLBACK_COLUMNS[object.name] ?? []) searchableColumns.add(col);
      const cols = Array.from(searchableColumns);
      if (cols.length > 0) {
        const coalesceExpr = cols.map((col) => `nullif(${quoteIdentifier(col)}::text, '')`).join(", ");
        const whereExpr = cols.map((col) => `lower(${quoteIdentifier(col)}::text) like lower($1)`).join(" or ");
        const sql = `select id as entry_id, coalesce(${coalesceExpr}, id::text) as label from ${tableName} where ${whereExpr} order by updated_at desc nulls last, id desc limit $2`;
        const rows = await queryPg<{ entry_id: string; label: string }>(sql, [`%${trimmed}%`, remaining]);
        for (const row of rows) {
          if (!row.entry_id || seenEntryIds.has(row.entry_id)) continue;
          seenEntryIds.add(row.entry_id);
          items.push({
            name: row.label || row.entry_id,
            path: `workspace:entry:${object.name}:${row.entry_id}`,
            type: "entry",
            icon: object.icon ?? undefined,
            objectName: object.name,
            entryId: row.entry_id,
          });
          if (items.length >= max) break;
        }
      }
    }

    if (items.length >= max) break;
    const customRows = await queryPg<{ entry_id: string; label: string }>(
      `select cfv.entry_id,
              min(coalesce(cfv.text_value, cfv.json_value::text, cfv.number_value::text, cfv.date_value::text, cfv.boolean_value::text, cfv.entry_id)) as label
         from crm_custom_field_values cfv
         join crm_fields f on f.id = cfv.field_id
        where cfv.object_id = $1
          and lower(coalesce(cfv.text_value, cfv.json_value::text, '')) like lower($2)
        group by cfv.entry_id
        order by max(cfv.updated_at) desc nulls last, cfv.entry_id desc
        limit $3`,
      [object.id, `%${trimmed}%`, max - items.length],
    );
    for (const row of customRows) {
      if (!row.entry_id || seenEntryIds.has(row.entry_id)) continue;
      seenEntryIds.add(row.entry_id);
      items.push({
        name: row.label || row.entry_id,
        path: `workspace:entry:${object.name}:${row.entry_id}`,
        type: "entry",
        icon: object.icon ?? undefined,
        objectName: object.name,
        entryId: row.entry_id,
      });
      if (items.length >= max) break;
    }
  }

  return items;
}
