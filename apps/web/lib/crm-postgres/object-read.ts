import type { FilterGroup, FilterRule, SavedView, SortRule, ViewType, ViewTypeSettings } from "../object-filters";
import { deserializeFilters } from "../object-filters";
import { queryPg } from "../postgres";
import { buildGoogleFaviconUrl } from "../workspace-cell-format";

type ObjectRow = {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
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

type CustomValueRow = {
  entry_id: string;
  field_name: string;
  text_value?: string | null;
  number_value?: number | string | null;
  boolean_value?: boolean | null;
  date_value?: string | Date | null;
  json_value?: unknown;
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
  email_thread: "crm_email_threads",
  email_message: "crm_email_messages",
  calendar_event: "crm_calendar_events",
  interaction: "crm_interactions",
};

const textLikeTypes = new Set(["text", "richtext", "email", "url", "phone"]);

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function resolveDisplayField(object: ObjectRow, fields: FieldRow[]): string {
  if (object.display_field) return object.display_field;

  const nameField = fields.find((field) => /\bname\b/i.test(field.name) || /\btitle\b/i.test(field.name));
  if (nameField) return nameField.name;

  const textField = fields.find((field) => field.type === "text");
  if (textField) return textField.name;

  return fields[0]?.name ?? "id";
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

function customValue(row: CustomValueRow): unknown {
  if (row.json_value !== undefined && row.json_value !== null) return row.json_value;
  if (row.text_value !== undefined && row.text_value !== null) return row.text_value;
  if (row.number_value !== undefined && row.number_value !== null) return Number(row.number_value);
  if (row.boolean_value !== undefined && row.boolean_value !== null) return row.boolean_value;
  if (row.date_value !== undefined && row.date_value !== null) return row.date_value;
  return null;
}

function buildEntrySelect(fields: FieldRow[]): string {
  const canonicalSelects = fields
    .filter((field) => field.canonical_column)
    .map((field) => `${quoteIdentifier(field.canonical_column!)} as ${quoteIdentifier(field.name)}`);

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

function appendCustomValueExpression(field: FieldRow, tableAlias: string, params: unknown[]): string {
  params.push(field.id);
  return `(select coalesce(cfv.text_value, cfv.number_value::text, cfv.boolean_value::text, cfv.date_value::text, cfv.json_value::text)
            from crm_custom_field_values cfv
            where cfv.object_id = $1 and cfv.field_id = $${params.length} and cfv.entry_id = ${tableAlias}.id
            limit 1)`;
}

function appendFieldExpression(field: FieldRow, tableAlias: string, params: unknown[]): string {
  if (field.canonical_column) return `${tableAlias}.${quoteIdentifier(field.canonical_column)}`;
  return appendCustomValueExpression(field, tableAlias, params);
}

function buildRuleCondition(rule: FilterRule, fieldsByName: Map<string, FieldRow>, tableAlias: string, params: unknown[]): string | null {
  const field = fieldsByName.get(rule.field);
  if (!field) return null;
  const expr = appendFieldExpression(field, tableAlias, params);
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

function buildFilterCondition(group: FilterGroup | undefined, fieldsByName: Map<string, FieldRow>, tableAlias: string, params: unknown[]): string | null {
  if (!group?.rules.length) return null;
  const parts = group.rules
    .map((rule) => isFilterGroup(rule) ? buildFilterCondition(rule, fieldsByName, tableAlias, params) : buildRuleCondition(rule, fieldsByName, tableAlias, params))
    .filter((part): part is string => !!part);
  if (parts.length === 0) return null;
  return `(${parts.join(group.conjunction === "or" ? " or " : " and ")})`;
}

function buildSearchCondition(search: string | null, fields: FieldRow[], tableAlias: string, params: unknown[]): string | null {
  const trimmed = search?.trim();
  if (!trimmed) return null;
  params.push(`%${trimmed}%`);
  const placeholder = `$${params.length}`;
  const textFields = fields.filter((field) => textLikeTypes.has(field.type));
  const parts = textFields
    .filter((field) => field.canonical_column)
    .map((field) => `lower(${tableAlias}.${quoteIdentifier(field.canonical_column!)}::text) like lower(${placeholder})`);
  const customFieldIds = textFields
    .filter((field) => !field.canonical_column)
    .map((field) => field.id);
  if (customFieldIds.length) {
    params.push(customFieldIds);
    parts.push(
      `exists (select 1 from crm_custom_field_values cfv where cfv.object_id = $1 and cfv.entry_id = ${tableAlias}.id and cfv.field_id = any($${params.length}::text[]) and lower(coalesce(cfv.text_value, cfv.json_value::text, '')) like lower(${placeholder}))`,
    );
  }
  return parts.length ? `(${parts.join(" or ")})` : null;
}

function buildOrderBy(sort: SortRule[] | undefined, fieldsByName: Map<string, FieldRow>, tableAlias: string, params: unknown[]): string {
  const parts: string[] = [];
  for (const rule of sort ?? []) {
    const direction = rule.direction === "asc" ? "asc" : "desc";
    if (rule.field === "created_at" || rule.field === "updated_at") {
      parts.push(`${tableAlias}.${quoteIdentifier(rule.field)} ${direction}`);
      continue;
    }
    const field = fieldsByName.get(rule.field);
    if (field?.canonical_column) {
      parts.push(`${tableAlias}.${quoteIdentifier(field.canonical_column)} ${direction}`);
    } else if (field) {
      parts.push(`${appendCustomValueExpression(field, tableAlias, params)} ${direction} nulls last`);
    }
  }
  parts.push(`${tableAlias}.created_at desc`, `${tableAlias}.id desc`);
  return parts.join(", ");
}

async function loadEntries(object: ObjectRow, fields: FieldRow[], pageSize: number, offset: number, whereClause: string, params: unknown[], orderBy: string): Promise<Record<string, unknown>[]> {
  const tableName = supportedTables[object.name];
  if (!tableName) return [];

  const selectList = buildEntrySelect(fields);
  const listParams = [...params, pageSize, offset];
  const entries = await queryPg<Record<string, unknown>>(
    `select ${selectList} from ${tableName} e ${whereClause} order by ${orderBy} limit $${listParams.length - 1} offset $${listParams.length}`,
    listParams,
  );

  if (entries.length === 0) return entries;

  const customRows = await queryPg<CustomValueRow>(
    `select cfv.entry_id, f.name as field_name, cfv.text_value, cfv.number_value, cfv.boolean_value, cfv.date_value, cfv.json_value
     from crm_custom_field_values cfv
     join crm_fields f on f.id = cfv.field_id
     where cfv.object_id = $1 and cfv.entry_id = any($2::text[])`,
    [object.id, entries.map((entry) => entry.entry_id)],
  );

  const entriesById = new Map(entries.map((entry) => [String(entry.entry_id), entry]));
  for (const row of customRows) {
    const entry = entriesById.get(row.entry_id);
    if (entry) entry[row.field_name] = customValue(row);
  }

  return entries;
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
    if (ids.size === 0) continue;

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
    for (const id of ids) labels[field.name][id] ??= id;
  }
  return { labels, faviconUrls };
}

export async function getPostgresObjectData(objectName: string, url: URL): Promise<PostgresObjectData> {
  const objects = await queryPg<ObjectRow>("select * from crm_objects where name = $1 limit 1", [objectName]);
  const object = objects[0];
  if (!object) {
    throw new Error(`CRM object not found: ${objectName}`);
  }

  const fields = await queryPg<FieldRow>(
    `select f.*, related.name as related_object_name
       from crm_fields f
       left join crm_objects related on related.id = f.related_object_id
      where f.object_id = $1
      order by f.sort_order`,
    [object.id],
  );
  const statuses = await queryPg<StatusRow>("select * from crm_statuses where object_id = $1 order by sort_order", [object.id]);
  const savedViewRows = await queryPg<SavedViewRow>("select * from crm_saved_views where object_id = $1 order by sort_order", [object.id]);
  const settingsRows = await queryPg<ObjectViewSettingsRow>("select * from crm_object_view_settings where object_id = $1 limit 1", [object.id]);

  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSizeParam = url.searchParams.get("pageSize") ?? url.searchParams.get("pagesize");
  const pageSize = Math.min(5000, Math.max(1, Number(pageSizeParam) || 100));
  const offset = (page - 1) * pageSize;

  const tableName = supportedTables[object.name];
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const params: unknown[] = [object.id];
  const conditions = [
    buildSearchCondition(url.searchParams.get("search"), fields, "e", params),
    buildFilterCondition(parseFilters(url.searchParams.get("filters")), fieldsByName, "e", params),
  ].filter((condition): condition is string => !!condition);
  const whereClause = `where $1::text is not null${conditions.length ? ` and ${conditions.join(" and ")}` : ""}`;
  const sort = parseJsonParam<SortRule[]>(url.searchParams.get("sort"));
  const totalCountRows = tableName
    ? await queryPg<{ count: string | number }>(`select count(*) from ${tableName} e ${whereClause}`, params)
    : [];
  const orderBy = buildOrderBy(sort, fieldsByName, "e", params);
  const totalCount = Number(totalCountRows[0]?.count ?? 0);
  const entries = await loadEntries(object, fields, pageSize, offset, whereClause, params, orderBy);
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
    effectiveDisplayField: resolveDisplayField(object, fields),
    savedViews,
    activeView,
    viewSettings: settingsRows[0]?.settings ?? undefined,
    totalCount,
    page,
    pageSize,
  };
}
