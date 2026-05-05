import type { ActionConfig, ActionContext } from "@/lib/action-runner";
import { queryPg } from "@/lib/postgres";

type ActionFieldRow = {
  object_id: string;
  default_value: string | null;
};

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

function parseActionConfig(defaultValue: string | null): ActionConfig[] {
  if (!defaultValue) return [];
  try {
    const parsed = JSON.parse(defaultValue);
    if (parsed && Array.isArray(parsed.actions)) return parsed.actions as ActionConfig[];
  } catch {}
  return [];
}

function pickCustomValue(row: {
  text_value?: string | null;
  number_value?: number | string | null;
  boolean_value?: boolean | null;
  date_value?: string | Date | null;
  json_value?: unknown;
}): unknown {
  if (row.json_value !== undefined && row.json_value !== null) return row.json_value;
  if (row.text_value !== undefined && row.text_value !== null) return row.text_value;
  if (row.number_value !== undefined && row.number_value !== null) return Number(row.number_value);
  if (row.boolean_value !== undefined && row.boolean_value !== null) return row.boolean_value;
  if (row.date_value !== undefined && row.date_value !== null) return row.date_value;
  return null;
}

export async function getPostgresActionConfig(objectName: string, fieldId: string, actionId: string): Promise<{ objectId: string; action: ActionConfig } | null> {
  const rows = await queryPg<ActionFieldRow>(
    `select f.object_id, f.default_value
       from crm_fields f
       join crm_objects o on o.id = f.object_id
      where o.name = $1 and f.id = $2 and f.type = 'action'
      limit 1`,
    [objectName, fieldId],
  );
  const row = rows[0];
  if (!row) return null;
  const action = parseActionConfig(row.default_value).find((candidate) => candidate.id === actionId);
  if (!action) return null;
  return { objectId: row.object_id, action };
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

  const customRows = await queryPg<{
    entry_id: string;
    field_name: string;
    text_value?: string | null;
    number_value?: number | string | null;
    boolean_value?: boolean | null;
    date_value?: string | Date | null;
    json_value?: unknown;
  }>(
    `select cfv.entry_id, f.name as field_name, cfv.text_value, cfv.number_value, cfv.boolean_value, cfv.date_value, cfv.json_value
       from crm_custom_field_values cfv
       join crm_fields f on f.id = cfv.field_id
      where cfv.object_id = $1 and cfv.entry_id = any($2::text[])`,
    [object.id, entryIds],
  );
  for (const row of customRows) {
    const target = entries.get(row.entry_id) ?? { entry_id: row.entry_id };
    target[row.field_name] = pickCustomValue(row);
    entries.set(row.entry_id, target);
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
  await queryPg(
    `insert into crm_action_runs (action_id, field_id, entry_id, object_id, status, completed_at, result, error, exit_code)
     values ($1, $2, $3, $4, $5, now(), $6, $7, $8)`,
    [run.actionId, run.fieldId, run.entryId, run.objectId, run.status, run.result, run.error, run.exitCode],
  );
}

export async function getPostgresActionRuns(
  objectName: string,
  filters: { fieldId?: string | null; entryId?: string | null; actionId?: string | null; limit?: number },
): Promise<Record<string, unknown>[]> {
  const objects = await queryPg<{ id: string }>("select id from crm_objects where name = $1 limit 1", [objectName]);
  const object = objects[0];
  if (!object) return [];

  const where: string[] = ["object_id = $1"];
  const params: unknown[] = [object.id];

  if (filters.fieldId) {
    params.push(filters.fieldId);
    where.push(`field_id = $${params.length}`);
  }
  if (filters.entryId) {
    params.push(filters.entryId);
    where.push(`entry_id = $${params.length}`);
  }
  if (filters.actionId) {
    params.push(filters.actionId);
    where.push(`action_id = $${params.length}`);
  }

  params.push(Math.max(1, Math.min(Number(filters.limit ?? 20), 100)));
  const limitPlaceholder = `$${params.length}`;

  return queryPg<Record<string, unknown>>(
    `select id, action_id, field_id, entry_id, status, started_at, completed_at, result, error, exit_code
       from crm_action_runs
      where ${where.join(" and ")}
      order by started_at desc
      limit ${limitPlaceholder}`,
    params,
  );
}
