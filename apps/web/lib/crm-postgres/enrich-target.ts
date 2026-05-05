import { queryPg } from "../postgres";

export type EnrichmentTargetType = "people" | "company";

export async function getPostgresEnrichmentTarget(type: EnrichmentTargetType, id: string): Promise<{
  type: EnrichmentTargetType;
  id: string;
  lookupValue: string | null;
}> {
  const trimmedId = id?.trim();
  if (!trimmedId) {
    const err = new Error("Missing id.");
    (err as Error & { code?: string }).code = "INVALID_INPUT";
    throw err;
  }

  if (type === "people") {
    const rows = await queryPg<{ email: string | null }>(
      "select email from crm_people where id = $1 limit 1",
      [trimmedId],
    );
    return { type, id: trimmedId, lookupValue: rows[0]?.email ?? null };
  }

  const rows = await queryPg<{ domain: string | null }>(
    "select domain from crm_companies where id = $1 limit 1",
    [trimmedId],
  );
  return { type, id: trimmedId, lookupValue: rows[0]?.domain ?? null };
}
