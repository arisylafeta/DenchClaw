import type { FilterGroup, FilterRule, SavedView, SortRule, ViewType, ViewTypeSettings } from "../object-filters";
import { deserializeFilters } from "../object-filters";
import { queryPg } from "../postgres";
import { buildGoogleFaviconUrl } from "../workspace-cell-format";
import { getColumnFillRates, getTableColumns } from "./table-columns";

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
  related_object_name?: string;
};

type StatusRow = {
  id: string;
  name: string;
  color?: string | null;
  sort_order?: number | null;
  is_default?: boolean | null;
};

type SavedViewRow = {
  id: string;
  name: string;
  view_type?: ViewType | null;
  filters?: SavedView["filters"] | null;
  sort?: SavedView["sort"] | null;
  columns?: string[] | null;
  column_widths?: Record<string, number> | null;
  settings?: ViewTypeSettings | null;
};

type ObjectViewSettingsRow = {
  active_view_id?: string | null;
  settings?: ViewTypeSettings | null;
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
  automation_loop: "automation_loops",
  automation_loop_run: "automation_loop_runs",
};

const FILL_RATE_OBJECTS = new Set(["people", "company", "companies"]);
const textLikeTypes = new Set(["text", "richtext", "email", "url", "phone"]);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveDisplayField(object: ObjectRow, fields: FieldRow[]): string {
  if (object.display_field && fields.some((field) => field.name === object.display_field)) return object.display_field;

  const nameField = fields.find((field) => /\bname\b/i.test(field.name) || /\btitle\b/i.test(field.name));
  if (nameField) return nameField.name;

  const textField = fields.find((field) => field.type === "text");
  if (textField) return textField.name;

  return fields[0]?.name ?? "id";
}

function rankFieldsByFillRate(a: FieldRow, b: FieldRow, fillRates: Map<string, number>): number {
  const aRate = a.canonical_column && fillRates.has(a.canonical_column) ? fillRates.get(a.canonical_column)! : -1;
  const bRate = b.canonical_column && fillRates.has(b.canonical_column) ? fillRates.get(b.canonical_column)! : -1;
  if (aRate !== bRate) return bRate - aRate;
  return (a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER);
}

function toSavedView(row: SavedViewRow): SavedView & { id?: string } {
  return {
    id: row.id,
    name: row.name,
    view_type: row.view_type ?? undefined,
    filters: row.filters ?? undefined,
    sort: row.sort ?? undefined,
    columns: row.columns ?? undefined,
    column_widths: row.column_widths ?? undefined,
    settings: row.settings ?? undefined,
  };
}

const WORK_TASK_PREVIEW_LENGTH = 240;

function projectWorkTaskListFields(fields: FieldRow[]): FieldRow[] {
  const taskDetails = fields.find((field) => field.canonical_column === "task_details");
  if (!taskDetails) {return fields;}

  const preview: FieldRow = {
    ...taskDetails,
    id: `${taskDetails.id}_preview`,
    name: "Preview",
    type: "text",
  };
  const projected = fields.filter((field) => field !== taskDetails);
  const titleIndex = projected.findIndex((field) => field.name === "Title" || field.canonical_column === "title");
  projected.splice(titleIndex >= 0 ? titleIndex + 1 : 0, 0, preview);
  return projected;
}

function buildEntrySelect(fields: FieldRow[], existingColumns: Set<string>): string {
  const canonicalSelects = fields
    .filter((field) => field.canonical_column && existingColumns.has(field.canonical_column))
    .map((field) => {
      if (field.name === "Preview" && field.canonical_column === "task_details") {
        return `left(btrim(regexp_replace(coalesce(${quoteIdentifier(field.canonical_column)}, ''), '[[:space:]]+', ' ', 'g')), ${WORK_TASK_PREVIEW_LENGTH}) as ${quoteIdentifier(field.name)}`;
      }
      return `${quoteIdentifier(field.canonical_column!)} as ${quoteIdentifier(field.name)}`;
    });

  return [
    "id as entry_id",
    "created_at",
    "updated_at",
    ...canonicalSelects,
  ].join(", ");
}

function parseJsonParam<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

function parseFilters(value: string | null): FilterGroup | undefined {
  if (!value) return undefined;
  return deserializeFilters(value) ?? parseJsonParam<FilterGroup>(value);
}

function isFilterGroup(value: FilterRule | FilterGroup): value is FilterGroup {
  return "rules" in value;
}

function appendFieldExpression(field: FieldRow, tableAlias: string, existingColumns: Set<string>, _params: unknown[]): string | null {
  if (field.canonical_column && existingColumns.has(field.canonical_column)) return `${tableAlias}.${quoteIdentifier(field.canonical_column)}`;
  return null;
}

function buildRuleCondition(rule: FilterRule, fieldsByName: Map<string, FieldRow>, tableAlias: string, existingColumns: Set<string>, params: unknown[]): string | null {
  const field = fieldsByName.get(rule.field);
  if (!field) return null;
  const expr = appendFieldExpression(field, tableAlias, existingColumns, params);
  if (!expr) return null;
  switch (rule.operator) {
    case "is_empty":
      return `(${expr} is null or ${expr}::text = '')`;
    case "is_not_empty":
      return `(${expr} is not null and ${expr}::text <> '')`;
    case "is_true":
      return field.type === "boolean" ? `(${expr}) is true` : `lower(${expr}::text) = 'true'`;
    case "is_any_of": {
      const values = Array.isArray(rule.value) ? rule.value : rule.value == null ? [] : [String(rule.value)];
      if (values.length === 0) return null;
      params.push(values.map(String));
      return `${expr}::text = any($${params.length}::text[])`;
    }
    case "contains":
      params.push(`%${String(rule.value ?? "")}%`);
      return `lower(${expr}::text) like lower($${params.length})`;
    case "equals":
      params.push(String(rule.value ?? ""));
      return `${expr}::text = $${params.length}`;
    default:
      return null;
  }
}

function buildFilterCondition(group: FilterGroup | undefined, fieldsByName: Map<string, FieldRow>, tableAlias: string, existingColumns: Set<string>, params: unknown[]): string | null {
  if (!group?.rules.length) return null;
  const parts = group.rules
    .map((rule) => isFilterGroup(rule) ? buildFilterCondition(rule, fieldsByName, tableAlias, existingColumns, params) : buildRuleCondition(rule, fieldsByName, tableAlias, existingColumns, params))
    .filter((part): part is string => !!part);
  if (parts.length === 0) return null;
  return `(${parts.join(group.conjunction === "or" ? " or " : " and ")})`;
}

function buildSearchCondition(search: string | null, fields: FieldRow[], tableAlias: string, existingColumns: Set<string>, params: unknown[]): string | null {
  const trimmed = search?.trim();
  if (!trimmed) return null;
  params.push(`%${trimmed}%`);
  const placeholder = `$${params.length}`;
  const textFields = fields.filter((field) => textLikeTypes.has(field.type));
  const parts = textFields
    .filter((field) => field.canonical_column && existingColumns.has(field.canonical_column))
    .map((field) => `lower(${tableAlias}.${quoteIdentifier(field.canonical_column!)}::text) like lower(${placeholder})`);
  return parts.length ? `(${parts.join(" or ")})` : null;
}

function buildOrderBy(sort: SortRule[] | undefined, fieldsByName: Map<string, FieldRow>, tableAlias: string, existingColumns: Set<string>, _params: unknown[]): string {
  const parts: string[] = [];
  for (const rule of sort ?? []) {
    const direction = rule.direction === "asc" ? "asc" : "desc";
    if (rule.field === "created_at" || rule.field === "updated_at") {
      parts.push(`${tableAlias}.${quoteIdentifier(rule.field)} ${direction}`);
      continue;
    }
    const field = fieldsByName.get(rule.field);
    if (field?.canonical_column && existingColumns.has(field.canonical_column)) {
      parts.push(`${tableAlias}.${quoteIdentifier(field.canonical_column)} ${direction}`);
    }
  }
  parts.push(`${tableAlias}.created_at desc`, `${tableAlias}.id desc`);
  return parts.join(", ");
}

async function loadEntries(object: ObjectRow, fields: FieldRow[], existingColumns: Set<string>, pageSize: number, offset: number, whereClause: string, params: unknown[], orderBy: string, _search: string | null): Promise<Record<string, unknown>[]> {
  const tableName = supportedTables[object.name];
  if (!tableName) return loadCustomOnlyEntries(object, pageSize, offset, _search);

  const selectList = buildEntrySelect(fields, existingColumns);
  const listParams = [...params, pageSize, offset];
  const entries = await queryPg<Record<string, unknown>>(
    `select ${selectList} from ${tableName} e ${whereClause} order by ${orderBy} limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams,
  );

  return entries;
}

async function loadCustomOnlyEntries(_object: ObjectRow, _pageSize: number, _offset: number, _search: string | null): Promise<Record<string, unknown>[]> {
  return [];
}

async function countCustomOnlyEntries(_object: ObjectRow, _search: string | null): Promise<number> {
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
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

async function resolveRelationLabels(fields: FieldRow[], entries: Record<string, unknown>[]): Promise<{ labels: Record<string, Record<string, string>>; faviconUrls: Record<string, Record<string, string>> }> {
  const labels: Record<string, Record<string, string>> = {};
  const faviconUrls: Record<string, Record<string, string>> = {};
  for (const field of fields.filter((f) => f.type === "relation")) {
    const ids = new Set<string>();
    for (const entry of entries) for (const id of parseRelationValue(entry[field.name])) ids.add(id);
    labels[field.name] = {};
    faviconUrls[field.name] = {};
    const isProjectRelation = field.related_object_name === "project" || field.name === "Project";
    if (isProjectRelation) {
      // The Work Task board is an operational view. Finished Projects remain in
      // the database for history, but only Active Projects belong in its taxonomy.
      const rows = await queryPg<{ id: string; name: string }>(
        "select id, name from projects where status = 'Active' order by name",
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
    if (field.related_object_name === "company" || field.name === "Company") {
      const rows = await queryPg<{ id: string; name?: string | null; domain?: string | null; website?: string | null }>(
        "select id, name, domain, website from crm_companies where id = any($1::text[])",
        [Array.from(ids)],
      );
      for (const row of rows) {
        labels[field.name][row.id] = row.name || row.id;
        const href = row.website || row.domain;
        const favicon = href ? buildGoogleFaviconUrl(/^https?:\/\//i.test(href) ? href : `https://${href}`) : undefined;
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

export async function getPostgresObjectData(objectName: string, url: URL): Promise<PostgresObjectData> {
  const objects = await queryPg<ObjectRow>("select * from crm_objects where name = $1 limit 1", [objectName]);
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
  // crm_statuses, crm_saved_views, and crm_object_view_settings tables were dropped.
  const statuses: StatusRow[] = [];
  const savedViewRows: SavedViewRow[] = [];
  const settingsRows: ObjectViewSettingsRow[] = [];

  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSizeParam = url.searchParams.get("pageSize") ?? url.searchParams.get("pagesize");
  const pageSize = Math.min(5000, Math.max(1, Number(pageSizeParam) || 100));
  const offset = (page - 1) * pageSize;

  const tableName = supportedTables[object.name];
  const existingColumns = tableName ? await getTableColumns(tableName) : new Set<string>();
  if (tableName) {
    fields = fields.filter((field) => !field.canonical_column || existingColumns.has(field.canonical_column));
  }
  if (object.name === "work_task") {
    fields = projectWorkTaskListFields(fields);
  }
  const effectiveDisplayField = resolveDisplayField(object, fields);
  if (tableName && FILL_RATE_OBJECTS.has(object.name)) {
    const fillRates = await getColumnFillRates(tableName, existingColumns);
    fields = [...fields].sort((a, b) => rankFieldsByFillRate(a, b, fillRates));
  }
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const params: unknown[] = [object.id];
  const search = url.searchParams.get("search");
  const conditions = [
    buildSearchCondition(search, fields, "e", existingColumns, params),
    buildFilterCondition(parseFilters(url.searchParams.get("filters")), fieldsByName, "e", existingColumns, params),
  ].filter((condition): condition is string => !!condition);
  const whereClause = `where $1::text is not null${conditions.length ? ` and ${conditions.join(" and ")}` : ""}`;
  const sort = parseJsonParam<SortRule[]>(url.searchParams.get("sort"));
  const totalCountRows = tableName
    ? await queryPg<{ count: string | number }>(`select count(*) from ${tableName} e ${whereClause}`, params)
    : [];
  const orderBy = buildOrderBy(sort, fieldsByName, "e", existingColumns, params);
  const totalCount = tableName ? Number(totalCountRows[0]?.count ?? 0) : await countCustomOnlyEntries(object, search);
  const entries = await loadEntries(object, fields, existingColumns, pageSize, offset, whereClause, params, orderBy, search);
  const resolvedRelations = await resolveRelationLabels(fields, entries);

  const savedViews = savedViewRows.map(toSavedView);
  const activeViewId = settingsRows[0]?.active_view_id;
  const activeView = activeViewId ? savedViewRows.find((view) => view.id === activeViewId)?.name : undefined;

  return {
    object,
    fields,
    statuses,
    entries,
    relationLabels: resolvedRelations.labels,
    relationFaviconUrls: resolvedRelations.faviconUrls,
    reverseRelations: [],
    effectiveDisplayField,
    savedViews,
    activeView,
    viewSettings: settingsRows[0]?.settings ?? undefined,
    totalCount,
    page,
    pageSize,
  };
}
