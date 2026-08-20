import { queryPg } from "../postgres";
import { buildGoogleFaviconUrl } from "../workspace-cell-format";
import { getTableColumns } from "./table-columns";
import { buildWorkTaskReadScope } from "./work-task-read-scope";

type ObjectRow = {
  id: string;
  name: string;
  description?: string | null;
  default_view?: string | null;
  display_field?: string | null;
};

type FieldRow = {
  id: string;
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
  related_object_name?: string | null;
};

type ReverseRelationRow = {
  field_name: string;
  source_object_name: string;
  source_object_id?: string | null;
  source_entry_id: string;
  display_field?: string | null;
  label: string | null;
};

export type PostgresReverseRelation = {
  fieldName: string;
  sourceObjectName: string;
  sourceObjectId: string;
  displayField: string;
  links: Array<{ id: string; label: string }>;
};

export type PostgresEntryData = {
  object: ObjectRow;
  fields: FieldRow[];
  entry: Record<string, unknown>;
  relationLabels: Record<string, Record<string, string>>;
  relationFaviconUrls: Record<string, Record<string, string>>;
  reverseRelations: PostgresReverseRelation[];
  effectiveDisplayField: string;
};

const supportedTables: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
  campaign: "campaigns",
  campaigns: "campaigns",
  project: "projects",
  work_task: "work_tasks",
  crm_user: "crm_users",
  automation_loop: "automation_loops",
  automation_loop_run: "automation_loop_runs",
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveDisplayField(object: ObjectRow, fields: FieldRow[]): string {
  if (
    object.display_field &&
    fields.some((field) => field.name === object.display_field)
  )
    return object.display_field;

  const nameField = fields.find(
    (field) => /\bname\b/i.test(field.name) || /\btitle\b/i.test(field.name),
  );
  if (nameField) return nameField.name;

  const textField = fields.find((field) => field.type === "text");
  if (textField) return textField.name;

  return fields[0]?.name ?? "id";
}

function buildEntrySelect(
  fields: FieldRow[],
  existingColumns: Set<string>,
): string {
  const canonicalSelects = fields
    .filter(
      (field) =>
        field.canonical_column && existingColumns.has(field.canonical_column),
    )
    .map(
      (field) =>
        `${quoteIdentifier(field.canonical_column!)} as ${quoteIdentifier(field.name)}`,
    );

  return [
    "id as entry_id",
    "created_at",
    "updated_at",
    ...canonicalSelects,
  ].join(", ");
}

export async function getReverseRelationsForEntry(
  _objectName: string,
  entryId: string,
  userId = "",
): Promise<PostgresReverseRelation[]> {
  const rows = await queryPg<ReverseRelationRow>(
    `
    select f.name as field_name,
           o.name as source_object_name,
           o.id as source_object_id,
           l.source_entry_id,
           case
             when o.name = 'email_message' then 'Subject'
             when o.name = 'email_thread' then 'Subject'
             when o.name = 'calendar_event' then 'Title'
             when o.name = 'interaction' then 'Type'
             when o.name = 'people' then 'Full Name'
             when o.name in ('company', 'companies') then 'Company Name'
             when o.name = 'work_task' then 'Title'
             when o.name = 'project' then 'Name'
             when o.name = 'automation_loop_run' then 'Activity'
             else coalesce(o.display_field, display_field.name, 'id')
           end as display_field,
           coalesce(
             nullif(email_messages.subject, ''),
             nullif(email_threads.subject, ''),
             nullif(calendar_events.title, ''),
             nullif(trim(concat_ws(' ', interactions.type, interactions.occurred_at::text)), ''),
             nullif(people.full_name, ''),
             nullif(companies.name, ''),
             nullif(work_tasks.title, ''),
             nullif(projects.name, ''),
             nullif(automation_loop_runs.activity_name, ''),
             l.source_entry_id
           ) as label
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      left join crm_fields display_field
        on display_field.object_id = o.id
       and display_field.name = coalesce(o.display_field,
         case
           when o.name = 'email_message' then 'Subject'
           when o.name = 'email_thread' then 'Subject'
           when o.name = 'calendar_event' then 'Title'
           when o.name = 'interaction' then 'Type'
           when o.name = 'people' then 'Full Name'
           when o.name in ('company', 'companies') then 'Company Name'
           else null
         end)
      left join crm_email_messages email_messages on o.name = 'email_message' and email_messages.id = l.source_entry_id
      left join crm_email_threads email_threads on o.name = 'email_thread' and email_threads.id = l.source_entry_id
      left join crm_calendar_events calendar_events on o.name = 'calendar_event' and calendar_events.id = l.source_entry_id
      left join crm_interactions interactions on o.name = 'interaction' and interactions.id = l.source_entry_id
      left join crm_people people on o.name = 'people' and people.id = l.source_entry_id
      left join crm_companies companies on o.name in ('company', 'companies') and companies.id = l.source_entry_id
      left join work_tasks on o.name = 'work_task' and work_tasks.id = l.source_entry_id
      left join projects on o.name = 'project' and projects.id = l.source_entry_id
      left join automation_loop_runs on o.name = 'automation_loop_run' and automation_loop_runs.id = l.source_entry_id
     where l.target_entry_id = $1
       and (o.name <> 'work_task' or ${buildWorkTaskReadScope("work_tasks.assignee_id", "$2")})
       and (o.name <> 'email_message' or email_messages.mailbox_owner_id = $2::uuid)
       and (o.name <> 'email_thread' or email_threads.mailbox_owner_id = $2::uuid)
       and (o.name <> 'interaction' or interactions.email_message_id is null or exists (
         select 1 from crm_email_messages scoped_message
          where scoped_message.id = interactions.email_message_id
            and scoped_message.mailbox_owner_id = $2::uuid
       ))
     order by f.sort_order, l.position, l.source_entry_id
  `,
    [entryId, userId],
  );

  const grouped = new Map<string, PostgresReverseRelation>();
  for (const row of rows) {
    const key = `${row.field_name}\u0000${row.source_object_name}\u0000${row.source_object_id ?? ""}`;
    let relation = grouped.get(key);
    if (!relation) {
      relation = {
        fieldName: row.field_name,
        sourceObjectName: row.source_object_name,
        sourceObjectId: row.source_object_id ?? "",
        displayField: row.display_field ?? "id",
        links: [],
      };
      grouped.set(key, relation);
    }
    if (!relation.links.some((link) => link.id === row.source_entry_id)) {
      relation.links.push({
        id: row.source_entry_id,
        label: row.label ?? row.source_entry_id,
      });
    }
  }

  return Array.from(grouped.values());
}

function parseRelationValue(value: unknown): string[] {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "object") return [];
  const raw = String(value).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    if (typeof parsed === "string") return [parsed];
  } catch {}
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function resolveRelationLabels(
  fields: FieldRow[],
  entry: Record<string, unknown>,
): Promise<{
  labels: Record<string, Record<string, string>>;
  faviconUrls: Record<string, Record<string, string>>;
}> {
  const labels: Record<string, Record<string, string>> = {};
  const faviconUrls: Record<string, Record<string, string>> = {};
  for (const field of fields.filter((f) => f.type === "relation")) {
    const ids = parseRelationValue(entry[field.name]);
    labels[field.name] = {};
    faviconUrls[field.name] = {};
    if (ids.length === 0) continue;
    if (field.related_object_name === "project" || field.name === "Project") {
      const rows = await queryPg<{ id: string; name: string }>(
        "select id, name from projects where id = any($1::text[])",
        [Array.from(ids)],
      );
      for (const row of rows) labels[field.name][row.id] = row.name || row.id;
    }
    if (field.related_object_name === "automation_loop") {
      const rows = await queryPg<{ id: string; name: string }>(
        "select id, name from automation_loops where id = any($1::text[])",
        [Array.from(ids)],
      );
      for (const row of rows) labels[field.name][row.id] = row.name || row.id;
    }
    if (field.related_object_name === "crm_user") {
      const rows = await queryPg<{ id: string; email: string }>(
        "select id::text, email from crm_users where id = any($1::uuid[]) and is_active",
        [ids],
      );
      for (const row of rows)
        labels[field.name][row.id] = row.email || row.id;
    }
    if (field.related_object_name === "company" || field.name === "Company") {
      const rows = await queryPg<{
        id: string;
        name?: string | null;
        domain?: string | null;
        website?: string | null;
      }>(
        "select id, name, domain, website from crm_companies where id = any($1::text[])",
        [ids],
      );
      for (const row of rows) {
        labels[field.name][row.id] = row.name || row.id;
        const href = row.website || row.domain;
        const favicon = href
          ? buildGoogleFaviconUrl(
              /^https?:\/\//i.test(href) ? href : `https://${href}`,
            )
          : undefined;
        if (favicon) faviconUrls[field.name][row.id] = favicon;
      }
    }
    for (const id of ids) labels[field.name][id] ??= id;
  }
  return { labels, faviconUrls };
}

export async function getPostgresEntryData(
  objectName: string,
  entryId: string,
  userId = "",
): Promise<PostgresEntryData> {
  const objects = await queryPg<ObjectRow>(
    "select * from crm_objects where name = $1 limit 1",
    [objectName],
  );
  const object = objects[0];
  if (!object) {
    throw new Error(`CRM object not found: ${objectName}`);
  }

  let fields = await queryPg<FieldRow>(
    `select f.*, related.name as related_object_name
       from crm_fields f
       left join crm_objects related on related.id = f.related_object_id
      where f.object_id = $1
      order by f.sort_order`,
    [object.id],
  );

  const tableName = supportedTables[object.name];
  const existingColumns = tableName
    ? await getTableColumns(tableName)
    : new Set<string>();
  if (tableName) {
    fields = fields.filter(
      (field) =>
        !field.canonical_column || existingColumns.has(field.canonical_column),
    );
  }
  const entry = tableName
    ? (
        await queryPg<Record<string, unknown>>(
          `select ${buildEntrySelect(fields, existingColumns)} from ${tableName}
            where id = $1
              ${object.name === "work_task" ? `and ${buildWorkTaskReadScope("assignee_id", "$2")}` : ""}
              ${object.name === "email_thread" || object.name === "email_message" ? "and mailbox_owner_id = $2::uuid" : ""}
              ${object.name === "interaction" ? "and (email_message_id is null or exists (select 1 from crm_email_messages scoped_message where scoped_message.id = crm_interactions.email_message_id and scoped_message.mailbox_owner_id = $2::uuid))" : ""}
            limit 1`,
          object.name === "work_task" ||
            object.name === "email_thread" ||
            object.name === "email_message" ||
            object.name === "interaction"
            ? [entryId, userId]
            : [entryId],
        )
      )[0]
    : await loadCustomOnlyEntry(object.id, entryId);
  if (!entry) {
    throw new Error("Entry not found");
  }

  const resolvedRelations = await resolveRelationLabels(fields, entry);

  return {
    object,
    fields,
    entry,
    relationLabels: resolvedRelations.labels,
    relationFaviconUrls: resolvedRelations.faviconUrls,
    reverseRelations: await getReverseRelationsForEntry(
      object.name,
      entryId,
      userId,
    ),
    effectiveDisplayField: resolveDisplayField(object, fields),
  };
}

async function loadCustomOnlyEntry(
  _objectId: string,
  _entryId: string,
): Promise<Record<string, unknown> | null> {
  return null;
}
