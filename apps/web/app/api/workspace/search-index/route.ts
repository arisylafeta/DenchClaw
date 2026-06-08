import { readdirSync, readFileSync, existsSync, type Dirent } from "node:fs";
import { join } from "node:path";
import {
  resolveWorkspaceRoot,
  parseSimpleYaml,
  duckdbQueryAllAsync,
  discoverDuckDBPaths,
  duckdbQueryOnFileAsync,
  isDatabaseFile,
  pivotViewIdentifier,
  readObjectYamlIcon,
} from "@/lib/workspace";
import { queryPg } from "@/lib/postgres";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Safely convert an unknown DB value to a display string. */
function dbStr(val: unknown): string {
  if (val == null) {return "";}
  if (typeof val === "object") {return JSON.stringify(val);}
  return String(val as string | number | boolean);
}

// --- Types ---

export type SearchIndexItem = {
  /** Unique key: relative path for files, entryId for entries */
  id: string;
  /** Primary display text (filename or display-field value) */
  label: string;
  /** Secondary text (path for files, object name for entries) */
  sublabel?: string;
  /** Item kind for grouping and icons */
  kind: "file" | "object" | "entry";
  /** Icon hint */
  icon?: string;

  // Entry-specific
  objectName?: string;
  entryId?: string;
  /** First few field key-value pairs for search and preview */
  fields?: Record<string, string>;

  // File/object-specific
  path?: string;
  nodeType?: "document" | "folder" | "file" | "report" | "database";
  defaultView?: "table" | "kanban";
};

// --- DB types ---

type ObjectRow = {
  id: string;
  name: string;
  description?: string;
  default_view?: string;
  display_field?: string;
};

type FieldRow = {
  id: string;
  name: string;
  type: string;
  sort_order?: number;
};

type EavRow = {
  entry_id: string;
  created_at: string;
  updated_at: string;
  field_name: string;
  value: string | null;
};

const POSTGRES_TABLE_BY_OBJECT: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
};

// --- Helpers ---

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function isPostgresBackend(): boolean {
  return process.env.CRM_DB_BACKEND === "postgres";
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** Determine the display field (same heuristic as the objects route). */
function resolveDisplayField(obj: ObjectRow, fields: FieldRow[]): string {
  if (obj.display_field) {return obj.display_field;}

  const nameField = fields.find(
    (f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
  );
  if (nameField) {return nameField.name;}

  const textField = fields.find((f) => f.type === "text");
  if (textField) {return textField.name;}

  return fields[0]?.name ?? "id";
}

function buildPostgresEntrySelect(fields: FieldRow[]): string {
  const canonicalSelects = fields
    .filter((field) => typeof (field as FieldRow & { canonical_column?: string | null }).canonical_column === "string")
    .map((field) => {
      const canonical = (field as FieldRow & { canonical_column: string }).canonical_column;
      return `${quoteIdentifier(canonical)} as ${quoteIdentifier(field.name)}`;
    });

  return ["id as entry_id", "created_at", "updated_at", ...canonicalSelects].join(", ");
}

async function readPostgresObjects(): Promise<ObjectRow[]> {
  return queryPg<ObjectRow>(
    `select id, name, description, default_view, display_field
       from crm_objects
      order by name`,
  );
}

async function readPostgresFields(objectId: string): Promise<FieldRow[]> {
  return queryPg<FieldRow & { canonical_column?: string | null }>(
    `select id, name, type, canonical_column, sort_order
       from crm_fields
      where object_id = $1
      order by sort_order`,
    [objectId],
  );
}

async function readPostgresCustomEntries(objectId: string): Promise<Record<string, unknown>[]> {
  const rows = await queryPg<{
    entry_id: string;
    field_name: string;
    value: string | null;
  }>(
    `select cfv.entry_id,
            f.name as field_name,
            coalesce(cfv.text_value, cfv.number_value::text, cfv.boolean_value::text, cfv.date_value::text, cfv.json_value::text) as value
       from crm_custom_field_values cfv
       join crm_fields f on f.id = cfv.field_id
      where cfv.object_id = $1
      order by cfv.updated_at desc
      limit 2500`,
    [objectId],
  );

  const grouped = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    let entry = grouped.get(row.entry_id);
    if (!entry) {
      entry = { entry_id: row.entry_id };
      grouped.set(row.entry_id, entry);
    }
    if (row.field_name) {
      entry[row.field_name] = row.value;
    }
  }
  return Array.from(grouped.values()).slice(0, 500);
}

async function buildPostgresEntryItems(objects: ObjectRow[]): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];

  for (const obj of objects) {
    const fields = await readPostgresFields(obj.id);
    const displayField = resolveDisplayField(obj, fields);
    const previewFields = fields
      .filter((f) => !["relation", "richtext"].includes(f.type))
      .slice(0, 4);
    const tableName = POSTGRES_TABLE_BY_OBJECT[obj.name];
    const entries = tableName
      ? await queryPg<Record<string, unknown>>(
        `select ${buildPostgresEntrySelect(fields)}
           from ${tableName}
          order by created_at desc
          limit 500`,
      )
      : await readPostgresCustomEntries(obj.id);
    const objIcon = readObjectYamlIcon(obj.name);

    for (const entry of entries) {
      const entryId = dbStr(entry.entry_id);
      if (!entryId) {continue;}

      const displayValue = dbStr(entry[displayField]);
      const fieldPreview: Record<string, string> = {};
      for (const f of previewFields) {
        const val = entry[f.name];
        if (val != null && val !== "") {
          fieldPreview[f.name] = dbStr(val);
        }
      }

      items.push({
        id: `entry:${obj.name}:${entryId}`,
        label: displayValue || `(${obj.name} entry)`,
        sublabel: obj.name,
        kind: "entry",
        icon: objIcon,
        objectName: obj.name,
        entryId,
        fields: Object.keys(fieldPreview).length > 0 ? fieldPreview : undefined,
      });
    }
  }

  return items;
}

/** Flatten a tree recursively to produce file/object search items. */
function flattenTree(
  absDir: string,
  relBase: string,
  dbObjects: Map<string, ObjectRow>,
  items: SearchIndexItem[],
) {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {continue;}

    const absPath = join(absDir, entry.name);
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const dbObj = dbObjects.get(entry.name);
      // Check for .object.yaml
      const yamlPath = join(absPath, ".object.yaml");
      const hasYaml = existsSync(yamlPath);

      if (dbObj || hasYaml) {
        let icon: string | undefined;
        if (hasYaml) {
          try {
            const parsed = parseSimpleYaml(
              readFileSync(yamlPath, "utf-8"),
            );
            icon = parsed.icon as string | undefined;
          } catch {
            // ignore
          }
        }

        items.push({
          id: relPath,
          label: entry.name,
          sublabel: relPath,
          kind: "object",
          icon,
          path: relPath,
          nodeType: undefined,
          defaultView: (dbObj?.default_view === "kanban" ? "kanban" : "table") as "table" | "kanban",
        });
      } else {
        // Regular folder -- don't add as item, but recurse
      }

      flattenTree(absPath, relPath, dbObjects, items);
    } else if (entry.isFile()) {
      const isReport = entry.name.endsWith(".report.json");
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      items.push({
        id: relPath,
        label: entry.name,
        sublabel: relPath,
        kind: "file",
        path: relPath,
        nodeType: isReport
          ? "report"
          : isDatabase
            ? "database"
            : isDocument
              ? "document"
              : "file",
      });
    }
  }
}

/**
 * Fetch all entries from all objects across ALL discovered DuckDB files.
 * Deduplicates objects by name (shallower DBs win).
 */
async function buildEntryItems(): Promise<SearchIndexItem[]> {
  const items: SearchIndexItem[] = [];
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) {return [];}

  // Collect all objects across DBs, deduplicating by name (shallowest wins)
  const seenNames = new Set<string>();
  const objectsWithDb: Array<{ obj: ObjectRow; dbPath: string }> = [];

  for (const dbPath of dbPaths) {
    const objs = await duckdbQueryOnFileAsync<ObjectRow>(dbPath,
      "SELECT * FROM objects ORDER BY name",
    );
    for (const obj of objs) {
      if (seenNames.has(obj.name)) {continue;}
      seenNames.add(obj.name);
      objectsWithDb.push({ obj, dbPath });
    }
  }

  for (const { obj, dbPath } of objectsWithDb) {
    const fields = await duckdbQueryOnFileAsync<FieldRow>(dbPath,
      `SELECT * FROM fields WHERE object_id = '${sqlEscape(obj.id)}' ORDER BY sort_order`,
    );
    const displayField = resolveDisplayField(obj, fields);
    const previewFields = fields
      .filter((f) => !["relation", "richtext"].includes(f.type))
      .slice(0, 4);
    // Icon comes from .object.yaml — DuckDB no longer stores it.
    const objIcon = readObjectYamlIcon(obj.name);

    // Try PIVOT view first, then raw EAV (on the same DB).
    // Use pivotViewIdentifier so object names with hyphens (e.g. "ai-agent")
    // resolve to the correct quoted identifier ("v_ai_agent") instead of
    // producing invalid SQL.
    let entries: Record<string, unknown>[] = await duckdbQueryOnFileAsync(dbPath,
      `SELECT * FROM ${pivotViewIdentifier(obj.name)} ORDER BY created_at DESC LIMIT 500`,
    );

    if (entries.length === 0) {
      const rawRows = await duckdbQueryOnFileAsync<EavRow>(dbPath,
        `SELECT e.id as entry_id, e.created_at, e.updated_at,
                f.name as field_name, ef.value
         FROM entries e
         JOIN entry_fields ef ON ef.entry_id = e.id
         JOIN fields f ON f.id = ef.field_id
         WHERE e.object_id = '${sqlEscape(obj.id)}'
         ORDER BY e.created_at DESC
         LIMIT 2500`,
      );

      const grouped = new Map<string, Record<string, unknown>>();
      for (const row of rawRows) {
        let entry = grouped.get(row.entry_id);
        if (!entry) {
          entry = { entry_id: row.entry_id };
          grouped.set(row.entry_id, entry);
        }
        if (row.field_name) {entry[row.field_name] = row.value;}
      }
      entries = Array.from(grouped.values());
    }

    for (const entry of entries) {
      const entryId = dbStr(entry.entry_id);
      if (!entryId) {continue;}

      const displayValue = dbStr(entry[displayField]);
      const fieldPreview: Record<string, string> = {};
      for (const f of previewFields) {
        const val = entry[f.name];
        if (val != null && val !== "") {
          fieldPreview[f.name] = dbStr(val);
        }
      }

      items.push({
        id: `entry:${obj.name}:${entryId}`,
        label: displayValue || `(${obj.name} entry)`,
        sublabel: obj.name,
        kind: "entry",
        icon: objIcon,
        objectName: obj.name,
        entryId,
        fields: Object.keys(fieldPreview).length > 0 ? fieldPreview : undefined,
      });
    }
  }

  return items;
}

// --- Route handler ---

/**
 * Synthetic CRM nav shortcuts so cmd-K can jump straight to the CRM
 * top-level views (People / Companies / Inbox / Calendar). They render
 * with `kind: "file"` and a `path` value of `~crm/<view>`, which the
 * existing `parseWorkspaceLink` → `handleNavigate` flow recognizes.
 */
const CRM_NAV_ITEMS: SearchIndexItem[] = [
  { id: "~crm/people", label: "People", sublabel: "CRM", kind: "file", path: "~crm/people", nodeType: "folder", icon: "users" },
  { id: "~crm/companies", label: "Companies", sublabel: "CRM", kind: "file", path: "~crm/companies", nodeType: "folder", icon: "building" },
  { id: "~crm/inbox", label: "Inbox", sublabel: "CRM", kind: "file", path: "~crm/inbox", nodeType: "folder", icon: "inbox" },
  { id: "~crm/calendar", label: "Calendar", sublabel: "CRM", kind: "file", path: "~crm/calendar", nodeType: "folder", icon: "calendar" },
];

export async function GET() {
  const items: SearchIndexItem[] = [];
  const postgresMode = isPostgresBackend();
  const postgresObjects = postgresMode ? await readPostgresObjects() : [];

  // 1. Files + objects from tree
  const root = resolveWorkspaceRoot();
  if (root) {
    // Aggregate objects from ALL discovered DuckDB files (shallower wins).
    // Important: we do NOT filter on `hidden_in_sidebar` here — entries
    // from CRM-only objects (email_thread / email_message / calendar_event /
    // interaction) still need to be reachable via global search even
    // though their parent objects are absent from the file tree.
    const dbObjects = new Map<string, ObjectRow>();
    const objs = postgresMode
      ? postgresObjects
      : await duckdbQueryAllAsync<ObjectRow & { name: string }>(
        "SELECT * FROM objects",
        "name",
      );
    for (const o of objs) {dbObjects.set(o.name, o);}

    // Scan workspace root (the workspace folder IS the knowledge base)
    flattenTree(root, "", dbObjects, items);
  }

  // 2. Entries from all objects across all discovered DBs.
  // `buildEntryItems` deliberately doesn't filter on `hidden_in_sidebar`
  // either — see the same rationale above.
  if (postgresMode) {
    items.push(...await buildPostgresEntryItems(postgresObjects));
  } else {
    const dbPaths = discoverDuckDBPaths();
    if (dbPaths.length > 0) {
      items.push(...await buildEntryItems());
    }
  }

  // 3. CRM nav shortcuts (People / Companies / Inbox / Calendar). Always
  // present so they're reachable even when the workspace is empty.
  items.push(...CRM_NAV_ITEMS);

  return Response.json({ items });
}
