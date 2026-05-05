export type CustomValueColumns = {
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
  date_value: string | null;
  json_value: unknown | null;
};

const textTypes = new Set(["text", "richtext", "email", "phone", "url", "enum", "file", "action"]);

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
  if (fieldType === "number") return { ...empty, number_value: Number(value) };
  if (fieldType === "boolean") return { ...empty, boolean_value: value === true || value === "true" };
  if (fieldType === "date") return { ...empty, date_value: String(value) };

  if (fieldType === "relation" || fieldType === "tags") {
    return { ...empty, json_value: Array.isArray(value) ? value : parseRelationIds(value) };
  }

  if (textTypes.has(fieldType)) return { ...empty, text_value: String(value) };

  return { ...empty, text_value: typeof value === "string" ? value : JSON.stringify(value) };
}
