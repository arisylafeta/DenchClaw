import type { ActionConfig, ActionContext } from "@/lib/action-runner";
import { queryPg } from "@/lib/postgres";

type FieldRow = {
  id: string;
  name: string;
  canonical_column: string | null;
};

type ActionRunRecord = {
  actionId: string;
  fieldId: string;
  entryId: string;
  objectId: string;
  status: string;
  result: string | null;
  error: string | null;
  exitCode: number | null;
};

const supportedTables: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
};

export async function getPostgresActionConfig(objectName: string, fieldId: string, actionId: string): Promise<{ objectId: string; action: ActionConfig } | null> {
  // Action config persistence is disabled: the `crm_action_runs` table was dropped and `default_value` is no longer a column on `crm_fields`.
  void objectName;
  void fieldId;
  void actionId;
  return null;
}

export async function getPostgresActionContexts(objectName: string, entryIds: string[]): Promise<ActionContext[]> {
  const objects = await queryPg<{ id: string; name: string }>("select id, name from crm_objects where name = $1 limit 1", [objectName]);
  const object = objects[0];
  if (!object || entryIds.length === 0) return [];

  const fields = await queryPg<FieldRow>(
    "select id, name, canonical_column from crm_fields where object_id = $1 and type <> 'action' order by sort_order",
    [object.id],
  );

  const tableName = supportedTables[object.name];
  const entries = new Map<string, Record<string, unknown>>();
  for (const id of entryIds) entries.set(id, { entry_id: id });

  if (tableName) {
    const canonicalFields = fields.filter((f) => !!f.canonical_column);
    if (canonicalFields.length > 0) {
      const selectSql = canonicalFields
        .map((field) => `e."${field.canonical_column!.replace(/"/g, '""')}" as "${field.name.replace(/"/g, '""')}"`)
        .join(", ");
      const rows = await queryPg<Record<string, unknown>>(
        `select e.id as entry_id, ${selectSql} from ${tableName} e where e.id = any($1::text[])`,
        [entryIds],
      );
      for (const row of rows) {
        const id = String(row.entry_id ?? "");
        if (!id) continue;
        const target = entries.get(id) ?? { entry_id: id };
        for (const [key, value] of Object.entries(row)) {
          if (key !== "entry_id") target[key] = value;
        }
        entries.set(id, target);
      }
    }
  }

  const workspacePath = process.cwd();
  const port = process.env.PORT || "3000";
  const apiUrl = `http://localhost:${port}/api`;

  return entryIds.map((entryId) => ({
    entryId,
    entryData: entries.get(entryId) ?? { entry_id: entryId },
    objectName,
    objectId: object.id,
    actionId: "",
    fieldId: "",
    workspacePath,
    dbPath: "",
    apiUrl,
  }));
}

export async function persistPostgresActionRun(run: ActionRunRecord): Promise<void> {
  // Persistence is currently disabled because the `crm_action_runs` table was dropped from the CRM Postgres schema.
  void run;
}

export async function getPostgresActionRuns(
  objectName: string,
  filters: { fieldId?: string | null; entryId?: string | null; actionId?: string | null; limit?: number },
): Promise<Record<string, unknown>[]> {
  // The `crm_action_runs` table was dropped from the CRM Postgres schema; return an empty list until persistence is restored.
  void objectName;
  void filters;
  return [];
}
