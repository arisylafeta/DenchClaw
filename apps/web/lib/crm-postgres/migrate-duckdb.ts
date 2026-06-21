import { duckdbPathAsync, duckdbQueryOnFileAsync, pivotViewIdentifier } from "../workspace";
import { withPgTransaction, type PgTransaction } from "../postgres";
import { getCanonicalField } from "./field-registry";

export type MigrationPlan = {
  duckdbPath: string;
  counts: Record<string, number>;
};

export type MigrationApplyResult = {
  duckdbPath: string;
  inserted: Record<string, number>;
};

type Row = Record<string, unknown>;

const EXTRA_CANONICAL_FIELDS: Record<string, Record<string, string>> = {
  email_thread: {
    Subject: "subject",
    "Last Message At": "last_message_at",
    "Message Count": "message_count",
    "Gmail Thread ID": "gmail_thread_id",
  },
  email_message: {
    Thread: "thread_id",
    Subject: "subject",
    "Sent At": "sent_at",
    From: "from_person_id",
    "Body Preview": "body_preview",
    Body: "body",
    "Has Attachments": "has_attachments",
    "Gmail Message ID": "gmail_message_id",
  },
  calendar_event: {
    Title: "title",
    "Start At": "start_at",
    "End At": "end_at",
    Organizer: "organizer_person_id",
    "Meeting Type": "meeting_type",
    "Google Event ID": "google_event_id",
  },
  interaction: {
    Type: "type",
    "Occurred At": "occurred_at",
    Person: "person_id",
    Company: "company_id",
    Email: "email_message_id",
    Event: "calendar_event_id",
    Direction: "direction",
    "Score Contribution": "score_contribution",
  },
};

function invertFieldMap(fieldsByName: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldsByName).map(([fieldName, column]) => [column, fieldName]));
}

const ENTITY_IMPORTS = [
  {
    objectName: "company",
    table: "crm_companies",
    columns: {
      name: "Company Name",
      domain: "Domain",
      website: "Website",
      phone: "Phone Number",
      linkedin_url: "LinkedIn URL",
      company_type: "Company Type",
      platform_role: "Platform Role",
      sector: "Company Sector",
      role_confidence: "Role Confidence",
      role_source: "Role Source",
      country: "Country",
      city: "City",
      employee_count: "Employee Count",
      strength_score: "Strength Score",
      last_interaction_at: "Last Interaction At",
    },
    requiredFallbacks: { name: "Untitled company" },
  },
  {
    objectName: "people",
    table: "crm_people",
    columns: {
      full_name: "Full Name",
      first_name: "First Name",
      last_name: "Last Name",
      email: "Email Address",
      phone: "Phone Number",
      company_id: "Company",
      source_company_name: "Source Company Name",
      company_domain: "Company Domain",
      job_title: "Job Title",
      linkedin_url: "LinkedIn URL",
      avatar_url: "Avatar URL",
      contact_type: "Contact Type",
      source: "Source",
      strength_score: "Strength Score",
      last_interaction_at: "Last Interaction At",
    },
  },
  { objectName: "email_thread", table: "crm_email_threads", columns: invertFieldMap(EXTRA_CANONICAL_FIELDS.email_thread) },
  { objectName: "email_message", table: "crm_email_messages", columns: invertFieldMap(EXTRA_CANONICAL_FIELDS.email_message) },
  { objectName: "calendar_event", table: "crm_calendar_events", columns: invertFieldMap(EXTRA_CANONICAL_FIELDS.calendar_event) },
  { objectName: "interaction", table: "crm_interactions", columns: invertFieldMap(EXTRA_CANONICAL_FIELDS.interaction) },
] as const;

type EntityImportSpec = (typeof ENTITY_IMPORTS)[number];

function requiredFallbackFor(spec: EntityImportSpec, column: string): unknown {
  if (!("requiredFallbacks" in spec)) { return null; }
  return spec.requiredFallbacks[column as keyof typeof spec.requiredFallbacks] ?? null;
}

function canonicalColumn(objectName: string, fieldName: string): string | null {
  return getCanonicalField(objectName, fieldName)?.column ?? EXTRA_CANONICAL_FIELDS[objectName]?.[fieldName] ?? null;
}

export function pickCanonicalValue(
  objectName: string,
  fieldName: string,
  row: Record<string, unknown>,
): unknown {
  if (!getCanonicalField(objectName, fieldName)) { return null; }
  const value = row[fieldName];
  if (fieldName.includes("Score") || fieldName.includes("Count") || fieldName.includes("Micros")) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "string" && value.trim() === "") { return null; }
  return value ?? null;
}

export function relationIdsFromValue(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") { return []; }
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map(String).map((id) => id.trim()).filter(Boolean) : [];
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}

export function isCustomField(objectName: string, fieldName: string): boolean {
  return getCanonicalField(objectName, fieldName) === null;
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) { return null; }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function cleanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") { return null; }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") { return value; }
  if (value === null || value === undefined) { return null; }
  const text = String(value).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y"].includes(text)) { return true; }
  if (["false", "f", "0", "no", "n"].includes(text)) { return false; }
  return null;
}

function cleanDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) { return null; }
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function cleanJson(value: unknown): string | null {
  if (value === null || value === undefined || value === "") { return null; }
  if (typeof value !== "string") { return JSON.stringify(value); }
  try { return JSON.stringify(JSON.parse(value)); } catch { return JSON.stringify(value); }
}

function valueForColumn(column: string, value: unknown): unknown {
  if (column.endsWith("_at")) { return cleanDate(value); }
  if (["strength_score", "employee_count", "message_count", "score_contribution"].includes(column)) {
    return cleanNumber(value);
  }
  if (column === "has_attachments") { return cleanBoolean(value); }
  return cleanText(value);
}

async function insertRows(
  client: PgTransaction,
  table: string,
  columns: readonly string[],
  rows: unknown[][],
  options: { onConflict?: string; batchSize?: number } = {},
): Promise<number> {
  if (rows.length === 0) { return 0; }
  let inserted = 0;
  const batchSize = options.batchSize ?? 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const params: unknown[] = [];
    const values = batch.map((row, rowIndex) => {
      const placeholders = row.map((value, columnIndex) => {
        params.push(value);
        return `$${rowIndex * columns.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    const result = await client.query(
      `insert into ${table} (${columns.join(", ")}) values ${values.join(", ")}${options.onConflict ? ` ${options.onConflict}` : ""}`,
      params,
    );
    inserted += result.rowCount ?? batch.length;
  }
  return inserted;
}

async function duckRows(dbPath: string, sql: string): Promise<Row[]> {
  try {
    return await duckdbQueryOnFileAsync<Row>(dbPath, sql);
  } catch {
    return [];
  }
}

export async function buildMigrationPlan(): Promise<MigrationPlan> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) { throw new Error("DuckDB database not found"); }
  const objects = ["people", "company", "email_thread", "email_message", "calendar_event", "interaction"];
  const counts: Record<string, number> = {};
  for (const objectName of objects) {
    const view = pivotViewIdentifier(objectName);
    const rows = await duckdbQueryOnFileAsync<{ cnt: number }>(dbPath, `select count(*) as cnt from ${view}`);
    counts[objectName] = Number(rows[0]?.cnt ?? 0);
  }
  return { duckdbPath: dbPath, counts };
}

export async function applyMigration(): Promise<MigrationApplyResult> {
  const dbPath = await duckdbPathAsync();
  if (!dbPath) { throw new Error("DuckDB database not found"); }

  const objects = await duckRows(dbPath, "select * from objects");
  const fields = await duckRows(dbPath, "select * from fields");
  const documents = await duckRows(dbPath, "select * from documents");
  const objectById = new Map(objects.map((obj) => [String(obj.id), obj]));
  const objectNameById = new Map(objects.map((obj) => [String(obj.id), String(obj.name)]));

  return withPgTransaction(async (client) => {
    const inserted: Record<string, number> = {};
    await client.query(`truncate
      crm_documents,
      crm_interactions,
      crm_calendar_events,
      crm_email_messages,
      crm_email_threads,
      crm_people,
      crm_companies,
      crm_fields,
      crm_objects
      cascade`);

    inserted.objects = await insertRows(client, "crm_objects", [
      "id", "name", "entity_table", "description", "default_view", "display_field", "immutable", "hidden_in_sidebar", "sort_order", "created_at", "updated_at",
    ], objects.map((obj) => [
      cleanText(obj.id), cleanText(obj.name), null, cleanText(obj.description), cleanText(obj.default_view) ?? "table", cleanText(obj.display_field), cleanBoolean(obj.immutable) ?? false, cleanBoolean(obj.hidden_in_sidebar) ?? false, cleanNumber(obj.sort_order) ?? 0, cleanDate(obj.created_at), cleanDate(obj.updated_at),
    ]));

    inserted.fields = await insertRows(client, "crm_fields", [
      "id", "object_id", "name", "type", "canonical_column", "description", "required", "enum_values", "enum_colors", "enum_multiple", "related_object_id", "relationship_type", "sort_order", "created_at", "updated_at",
    ], fields.map((field) => {
      const objectName = objectNameById.get(String(field.object_id)) ?? "";
      return [
        cleanText(field.id), cleanText(field.object_id), cleanText(field.name), cleanText(field.type) ?? "text", canonicalColumn(objectName, String(field.name)), cleanText(field.description), cleanBoolean(field.required) ?? false, cleanJson(field.enum_values), cleanJson(field.enum_colors), cleanBoolean(field.enum_multiple) ?? false, cleanText(field.related_object_id), cleanText(field.relationship_type), cleanNumber(field.sort_order) ?? 0, cleanDate(field.created_at), cleanDate(field.updated_at),
      ];
    }));

    inserted.documents = await insertRows(client, "crm_documents", ["id", "title", "icon", "file_path", "parent_object_id", "entry_id", "sort_order", "is_published", "created_at", "updated_at"], documents.map((row) => [
      cleanText(row.id), cleanText(row.title) ?? "Untitled", cleanText(row.icon), cleanText(row.file_path), cleanText(row.parent_object_id), cleanText(row.entry_id), cleanNumber(row.sort_order) ?? 0, cleanBoolean(row.is_published) ?? false, cleanDate(row.created_at), cleanDate(row.updated_at),
    ]));

    const idSets: Record<string, Set<string>> = {};
    for (const spec of ENTITY_IMPORTS) {
      const rows = await duckRows(dbPath, `select * from ${pivotViewIdentifier(spec.objectName)}`);
      idSets[spec.objectName] = new Set(rows.map((row) => cleanText(row.entry_id)).filter((id): id is string => Boolean(id)));
      const columns = ["id", ...Object.keys(spec.columns), "created_at", "updated_at"];
      const pgRows = rows.map((row) => {
        const values = Object.entries(spec.columns).map(([column, fieldName]) => {
          let value = valueForColumn(column, row[fieldName]);
          if (column === "company_id" && value && !idSets.company?.has(String(value))) { value = null; }
          if (column === "thread_id" && value && !idSets.email_thread?.has(String(value))) { value = null; }
          if (["from_person_id", "organizer_person_id", "person_id"].includes(column) && value && !idSets.people?.has(String(value))) { value = null; }
          if (column === "email_message_id" && value && !idSets.email_message?.has(String(value))) { value = null; }
          if (column === "calendar_event_id" && value && !idSets.calendar_event?.has(String(value))) { value = null; }
          return value ?? requiredFallbackFor(spec, column);
        });
        return [cleanText(row.entry_id), ...values, cleanDate(row.created_at), cleanDate(row.updated_at)];
      }).filter((row) => row[0]);
      inserted[spec.table] = await insertRows(client, spec.table, columns, pgRows);
    }

    return { duckdbPath: dbPath, inserted };
  });
}
