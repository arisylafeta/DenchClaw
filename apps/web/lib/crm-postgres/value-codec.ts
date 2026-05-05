export type CustomValueColumns = {
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
  date_value: string | null;
  json_value: unknown | null;
};

const textTypes = new Set(["text", "richtext", "email", "phone", "url", "enum", "file", "action"]);

function parseNumberValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function parseDateValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

export function parseRelationIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [trimmed];
}

export function relationStorageValue(ids: string[], relationshipType?: string | null): string | null {
  if (ids.length === 0) return null;
  return relationshipType === "many_to_many" ? JSON.stringify(ids) : ids[0];
}

export function toCustomValueColumns(fieldType: string, value: unknown): CustomValueColumns {
  const empty: CustomValueColumns = {
    text_value: null,
    number_value: null,
    boolean_value: null,
    date_value: null,
    json_value: null,
  };

  if (value == null || value === "") return empty;
  if (fieldType === "number") {
    const numberValue = parseNumberValue(value);
    return numberValue == null ? empty : { ...empty, number_value: numberValue };
  }
  if (fieldType === "boolean") {
    const booleanValue = parseBooleanValue(value);
    return booleanValue == null ? empty : { ...empty, boolean_value: booleanValue };
  }
  if (fieldType === "date") {
    const dateValue = parseDateValue(value);
    return dateValue == null ? empty : { ...empty, date_value: dateValue };
  }

  if (fieldType === "relation" || fieldType === "tags") {
    return { ...empty, json_value: Array.isArray(value) ? value : parseRelationIds(value) };
  }

  if (textTypes.has(fieldType)) return { ...empty, text_value: String(value) };

  return { ...empty, text_value: typeof value === "string" ? value : JSON.stringify(value) };
}
