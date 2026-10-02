import type {
  FilterGroup,
  FilterRule,
  SavedView,
  SortRule,
  ViewTypeSettings,
} from "../object-filters";
import { deserializeFilters } from "../object-filters";
import { queryPg } from "../postgres";
import { projectCampaignMetrics } from "./campaign-metrics";
import { buildGoogleFaviconUrl } from "../workspace-cell-format";
import { getColumnFillRates, getTableColumns } from "./table-columns";
import { buildWorkTaskReadScope } from "./work-task-read-scope";
import { getPostgresObjectViews } from "./views";
import { purposeEntity, purposeField, purposeFieldExpression } from "./purpose";

type ObjectRow = {
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
  read_only?: boolean;
  related_object_id?: string | null;
  relationship_type?: string | null;
  sort_order?: number | null;
  related_object_name?: string;
};

type StatusRow = {
  id: string;
  name: string;
  color?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
};

export type PostgresObjectData = {
  object: ObjectRow;
  fields: FieldRow[];
  statuses: StatusRow[];
  entries: Record<string, unknown>[];
  relationLabels: Record<string, Record<string, string>>;
  relationFaviconUrls: Record<string, Record<string, string>>;
  reverseRelations: unknown[];
  effectiveDisplayField: string;
  savedViews?: SavedView[];
  activeView?: string;
  viewSettings?: ViewTypeSettings;
  totalCount: number;
  page: number;
  pageSize: number;
};

const supportedTables: Record<string, string> = {
  people: "crm_people",
  company: "crm_companies",
  companies: "crm_companies",
  opportunity: "crm_commercial_opportunities",
  opportunities: "crm_commercial_opportunities",
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

const SQL_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/i;

function resolveObjectTable(object: ObjectRow): string | null {
  const registeredTable = object.entity_table?.trim();
  if (registeredTable) {
    if (!SQL_IDENTIFIER_RE.test(registeredTable)) {
      throw new Error(`Invalid registered entity table: ${registeredTable}`);
    }
    return registeredTable;
  }
  return supportedTables[object.name] ?? null;
}


const PEOPLE_FIELD_ORDER: Record<string, number> = {
  full_name: 0, company_id: 1, job_title: 2, Purpose: 3,
  tags: 4, email: 5, phone: 6, linkedin_url: 7,
  first_name: Number.MAX_SAFE_INTEGER - 1, last_name: Number.MAX_SAFE_INTEGER,
};
const FILL_RATE_OBJECTS = new Set(["people", "company", "companies"]);
const textLikeTypes = new Set(["text", "richtext", "email", "url", "phone"]);

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

function rankFieldsByFillRate(
  a: FieldRow,
  b: FieldRow,
  fillRates: Map<string, number>,
): number {
  const aRate =
    a.canonical_column && fillRates.has(a.canonical_column)
      ? fillRates.get(a.canonical_column)!
      : -1;
  const bRate =
    b.canonical_column && fillRates.has(b.canonical_column)
      ? fillRates.get(b.canonical_column)!
      : -1;
  if (aRate !== bRate) return bRate - aRate;
  return (
    (a.sort_order ?? Number.MAX_SAFE_INTEGER) -
    (b.sort_order ?? Number.MAX_SAFE_INTEGER)
  );
}

const WORK_TASK_PREVIEW_LENGTH = 240;

function projectWorkTaskListFields(fields: FieldRow[]): FieldRow[] {
  const taskDetails = fields.find(
    (field) => field.canonical_column === "task_details",
  );
  if (!taskDetails) {
    return fields;
  }

  const preview: FieldRow = {
    ...taskDetails,
    id: `${taskDetails.id}_preview`,
    name: "Preview",
    type: "text",
  };
  const projected = fields.filter((field) => field !== taskDetails);
  const titleIndex = projected.findIndex(
    (field) => field.name === "Title" || field.canonical_column === "title",
  );
  projected.splice(titleIndex >= 0 ? titleIndex + 1 : 0, 0, preview);
  return projected;
}

function buildEntrySelect(
  fields: FieldRow[],
  existingColumns: Set<string>,
): string {
  const canonicalSelects = fields.flatMap((field) => {
    const expression = appendFieldExpression(field, "e", existingColumns);
    if (!expression) return [];
    if (
      field.name === "Preview" &&
      field.canonical_column === "task_details"
    ) {
      return [`left(btrim(regexp_replace(coalesce(${expression}, ''), '[[:space:]]+', ' ', 'g')), ${WORK_TASK_PREVIEW_LENGTH}) as ${quoteIdentifier(field.name)}`];
    }
    return [`${expression} as ${quoteIdentifier(field.name)}`];
  });

  return [
    "e.id as entry_id",
    "e.created_at",
    "e.updated_at",
    ...canonicalSelects,
  ].join(", ");
}

function parseJsonParam<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseFilters(value: string | null): FilterGroup | undefined {
  if (!value) return undefined;
  return deserializeFilters(value) ?? parseJsonParam<FilterGroup>(value);
}

function isFilterGroup(value: FilterRule | FilterGroup): value is FilterGroup {
  return "rules" in value;
}

function appendFieldExpression(
  field: FieldRow,
  tableAlias: string,
  existingColumns: Set<string>,
): string | null {
  const purpose = purposeFieldExpression(field.id, tableAlias);
  if (purpose) return purpose;
  if (field.canonical_column && existingColumns.has(field.canonical_column))
    return `${tableAlias}.${quoteIdentifier(field.canonical_column)}`;
  return null;
}

function buildRuleCondition(
  rule: FilterRule,
  fieldsByName: Map<string, FieldRow>,
  tableAlias: string,
  existingColumns: Set<string>,
  params: unknown[],
): string | null {
  const field = fieldsByName.get(rule.field);
  if (!field) return null;
  const expr = appendFieldExpression(
    field,
    tableAlias,
    existingColumns,
  );
  if (!expr) return null;
  switch (rule.operator) {
    case "is_empty":
      return field.enum_multiple
        ? `coalesce(cardinality(${expr}), 0) = 0`
        : `(${expr} is null or ${expr}::text = '')`;
    case "is_not_empty":
      return field.enum_multiple
        ? `coalesce(cardinality(${expr}), 0) > 0`
        : `(${expr} is not null and ${expr}::text <> '')`;
    case "is_true":
      return field.type === "boolean"
        ? `(${expr}) is true`
        : `lower(${expr}::text) = 'true'`;
    case "is_false":
      return field.type === "boolean"
        ? `(${expr}) is not true`
        : `(${expr} is null or lower(${expr}::text) in ('', 'false', '0', 'no'))`;
    case "is_any_of": {
      const values = Array.isArray(rule.value)
        ? rule.value
        : rule.value == null
          ? []
          : [String(rule.value)];
      if (values.length === 0) return null;
      params.push(values.map(String));
      // A multi-value field (a text[] column such as tags) matches when it holds any of the values.
      if (field.enum_multiple) return `${expr} && $${params.length}::text[]`;
      return `${expr}::text = any($${params.length}::text[])`;
    }
    case "is_none_of": {
      const values = Array.isArray(rule.value)
        ? rule.value
        : rule.value == null
          ? []
          : [String(rule.value)];
      if (values.length === 0) return null;
      params.push(values.map(String));
      if (field.enum_multiple) return `(${expr} is null or not (${expr} && $${params.length}::text[]))`;
      return `(${expr} is null or not (${expr}::text = any($${params.length}::text[])))`;
    }
    case "contains":
      params.push(`%${String(rule.value ?? "")}%`);
      return `lower(${expr}::text) like lower($${params.length})`;
    case "equals":
    case "is":
      params.push(String(rule.value ?? ""));
      if (field.enum_multiple) return `$${params.length}::text = any(${expr})`;
      return `lower(${expr}::text) = lower($${params.length})`;
    case "not_equals":
    case "is_not":
      params.push(String(rule.value ?? ""));
      if (field.enum_multiple) return `(${expr} is null or not ($${params.length}::text = any(${expr})))`;
      return `(${expr} is null or lower(${expr}::text) <> lower($${params.length}))`;
    default:
      return null;
  }
}

function buildFilterCondition(
  group: FilterGroup | undefined,
  fieldsByName: Map<string, FieldRow>,
  tableAlias: string,
  existingColumns: Set<string>,
  params: unknown[],
): string | null {
  if (!group?.rules.length) return null;
  const parts = group.rules
    .map((rule) =>
      isFilterGroup(rule)
        ? buildFilterCondition(
            rule,
            fieldsByName,
            tableAlias,
            existingColumns,
            params,
          )
        : buildRuleCondition(
            rule,
            fieldsByName,
            tableAlias,
            existingColumns,
            params,
          ),
    )
    .filter((part): part is string => !!part);
  if (parts.length === 0) return null;
  return `(${parts.join(group.conjunction === "or" ? " or " : " and ")})`;
}

function buildSearchCondition(
  search: string | null,
  fields: FieldRow[],
  tableAlias: string,
  existingColumns: Set<string>,
  params: unknown[],
): string | null {
  const trimmed = search?.trim();
  if (!trimmed) return null;
  params.push(`%${trimmed}%`);
  const placeholder = `$${params.length}`;
  const textFields = fields.filter(
    (field) => textLikeTypes.has(field.type) || (field.name === "Purpose" && field.id.startsWith("virtual_")),
  );
  const parts = textFields.flatMap((field) => {
    const expression = appendFieldExpression(field, tableAlias, existingColumns);
    return expression ? [`lower(${expression}::text) like lower(${placeholder})`] : [];
  });
  return parts.length ? `(${parts.join(" or ")})` : null;
}

function buildOrderBy(
  sort: SortRule[] | undefined,
  fieldsByName: Map<string, FieldRow>,
  tableAlias: string,
  existingColumns: Set<string>,
): string {
  const parts: string[] = [];
  for (const rule of sort ?? []) {
    const direction = rule.direction === "asc" ? "asc" : "desc";
    if (rule.field === "created_at" || rule.field === "updated_at") {
      parts.push(`${tableAlias}.${quoteIdentifier(rule.field)} ${direction}`);
      continue;
    }
    const field = fieldsByName.get(rule.field);
    if (field) {
      const expression = appendFieldExpression(field, tableAlias, existingColumns);
      if (expression) parts.push(`${expression} ${direction}`);
    }
  }
  parts.push(`${tableAlias}.created_at desc`, `${tableAlias}.id desc`);
  return parts.join(", ");
}

async function loadEntries(
  object: ObjectRow,
  fields: FieldRow[],
  existingColumns: Set<string>,
  pageSize: number,
  offset: number,
  whereClause: string,
  params: unknown[],
  orderBy: string,
  _search: string | null,
): Promise<Record<string, unknown>[]> {
  const tableName = resolveObjectTable(object);
  if (!tableName)
    return loadCustomOnlyEntries(object, pageSize, offset, _search);

  const selectList = buildEntrySelect(fields, existingColumns);
  const listParams = [...params, pageSize, offset];
  const entries = await queryPg<Record<string, unknown>>(
    `select ${selectList} from ${tableName} e ${whereClause} order by ${orderBy} limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams,
  );

  return entries;
}

async function loadCustomOnlyEntries(
  _object: ObjectRow,
  _pageSize: number,
  _offset: number,
  _search: string | null,
): Promise<Record<string, unknown>[]> {
  return [];
}

async function countCustomOnlyEntries(
  _object: ObjectRow,
  _search: string | null,
): Promise<number> {
  return 0;
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
  entries: Record<string, unknown>[],
): Promise<{
  labels: Record<string, Record<string, string>>;
  faviconUrls: Record<string, Record<string, string>>;
}> {
  const labels: Record<string, Record<string, string>> = {};
  const faviconUrls: Record<string, Record<string, string>> = {};
  for (const field of fields.filter((f) => f.type === "relation")) {
    const ids = new Set<string>();
    for (const entry of entries)
      for (const id of parseRelationValue(entry[field.name])) ids.add(id);
    labels[field.name] = {};
    faviconUrls[field.name] = {};
    const isProjectRelation =
      field.related_object_name === "project" || field.name === "Project";
    if (isProjectRelation) {
      // The Work Task board is operational. Support both the canonical Active
      // status and legacy In Progress rows while excluding finished history.
      const rows = await queryPg<{ id: string; name: string }>(
        "select id, name from projects where status in ('Active', 'In Progress') order by name",
      );
      for (const row of rows) labels[field.name][row.id] = row.name || row.id;
    }
    if (ids.size === 0) continue;

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
        [Array.from(ids)],
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
        [Array.from(ids)],
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
    // Do not re-add Finished Project IDs from historical task rows.
    if (!isProjectRelation) {
      for (const id of ids) labels[field.name][id] ??= id;
    }
  }
  return { labels, faviconUrls };
}

export async function getPostgresObjectData(
  objectName: string,
  url: URL,
  userId = "",
): Promise<PostgresObjectData> {
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
  const statuses: StatusRow[] = [];
  const objectViews = await getPostgresObjectViews(object.name, userId);

  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSizeParam =
    url.searchParams.get("pageSize") ?? url.searchParams.get("pagesize");
  const pageSize = Math.min(5000, Math.max(1, Number(pageSizeParam) || 100));
  const offset = (page - 1) * pageSize;

  const tableName = resolveObjectTable(object);
  const existingColumns = tableName
    ? await getTableColumns(tableName)
    : new Set<string>();
  if (tableName) {
    fields = fields.filter(
      (field) =>
        !field.canonical_column || existingColumns.has(field.canonical_column),
    );
  }
  if (object.name === "work_task") {
    fields = projectWorkTaskListFields(fields);
  }
  const entity = purposeEntity(object.name);
  if (entity) {
    // Virtual metadata belongs only to the generic list, not stored classifications.
    fields = [...fields.filter((field) => field.name !== "Purpose"), purposeField(entity)];
  }
  const effectiveDisplayField = resolveDisplayField(object, fields);
  if (object.name === "people") {
    fields.sort((a, b) =>
      (PEOPLE_FIELD_ORDER[a.canonical_column ?? a.name] ?? 8) -
      (PEOPLE_FIELD_ORDER[b.canonical_column ?? b.name] ?? 8));
  } else if (tableName && FILL_RATE_OBJECTS.has(object.name)) {
    const fillRates = await getColumnFillRates(tableName, existingColumns);
    fields = [...fields].sort((a, b) => rankFieldsByFillRate(a, b, fillRates));
  }
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const params: unknown[] = [object.id];
  const search = url.searchParams.get("search");
  const rowScope =
    object.name === "work_task"
      ? (params.push(userId || null),
        buildWorkTaskReadScope("e.assignee_id", `$${params.length}`))
      : object.name === "email_thread" || object.name === "email_message"
        ? (params.push(userId || null), `e.mailbox_owner_id = $${params.length}::uuid`)
        : object.name === "interaction"
          ? (params.push(userId || null),
            `(e.email_message_id is null or exists (
            select 1 from crm_email_messages scoped_message
             where scoped_message.id = e.email_message_id
               and scoped_message.mailbox_owner_id = $${params.length}::uuid
          ))`)
          : null;
  const conditions = [
    rowScope,
    buildSearchCondition(search, fields, "e", existingColumns, params),
    buildFilterCondition(
      parseFilters(url.searchParams.get("filters")),
      fieldsByName,
      "e",
      existingColumns,
      params,
    ),
  ].filter((condition): condition is string => !!condition);
  const whereClause = `where $1::text is not null${conditions.length ? ` and ${conditions.join(" and ")}` : ""}`;
  const sort = parseJsonParam<SortRule[]>(url.searchParams.get("sort"));
  const totalCountRows = tableName
    ? await queryPg<{ count: string | number }>(
        `select count(*) from ${tableName} e ${whereClause}`,
        params,
      )
    : [];
  const orderBy = buildOrderBy(
    sort,
    fieldsByName,
    "e",
    existingColumns,
  );
  const totalCount = tableName
    ? Number(totalCountRows[0]?.count ?? 0)
    : await countCustomOnlyEntries(object, search);
  const loadedEntries = await loadEntries(
    object,
    fields,
    existingColumns,
    pageSize,
    offset,
    whereClause,
    params,
    orderBy,
    search,
  );
  const entries = object.name === "campaign" || object.name === "campaigns"
    ? await projectCampaignMetrics(loadedEntries)
    : loadedEntries;
  const resolvedRelations = await resolveRelationLabels(fields, entries);

  return {
    object,
    fields,
    statuses,
    entries,
    relationLabels: resolvedRelations.labels,
    relationFaviconUrls: resolvedRelations.faviconUrls,
    reverseRelations: [],
    effectiveDisplayField,
    savedViews: objectViews.views,
    activeView: objectViews.activeView,
    viewSettings: objectViews.viewSettings,
    totalCount,
    page,
    pageSize,
  };
}
