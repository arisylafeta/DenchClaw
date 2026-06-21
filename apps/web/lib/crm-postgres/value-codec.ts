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
