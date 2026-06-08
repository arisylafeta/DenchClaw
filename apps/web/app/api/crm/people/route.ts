import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
  wrapForOrderedAccess,
} from "@/lib/crm-queries";
import { getPostgresPeople } from "@/lib/crm-postgres/people";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/crm/people?limit=12
 *
 * Lightweight list endpoint used by surfaces that need a small "top N"
 * roster of real contacts — currently the onboarding sync preview, which
 * streams a People-table mock populated with the user's actual data as
 * the backfill lands rows into the workspace.
 *
 * Ordered by strength score descending so the most relevant people show
 * up first, mirroring the default sort on the real CRM list view. Rows
 * without an `entry_id` shouldn't exist, but we skip them defensively.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "12");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const data = await getPostgresPeople({ limit });
    return Response.json(data);
  }

  const fieldMaps = await loadCrmFieldMaps();

  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.people,
    fieldMap: fieldMaps.people,
    aliasedFields: [
      { name: "Full Name", alias: "name" },
      { name: "Email Address", alias: "email" },
      { name: "Company", alias: "company_id" },
      { name: "Strength Score", alias: "strength_score" },
      { name: "Last Interaction At", alias: "last_interaction_at" },
      { name: "Avatar URL", alias: "avatar_url" },
      { name: "Job Title", alias: "job_title" },
    ],
  });

  // Sort by numeric strength score descending; rows with no score sink to
  // the bottom. TRY_CAST keeps a malformed string (shouldn't happen, but
  // the column is value-typed) from blowing up the whole query.
  const ordered = wrapForOrderedAccess(
    projection,
    `TRY_CAST("strength_score" AS DOUBLE) DESC NULLS LAST, "last_interaction_at" DESC NULLS LAST`,
    limit,
  );

  const rows = await safeQuery<Record<string, string | null>>(ordered);

  // Dereference linked company names in one round trip so each row can
  // show "Acme" instead of a raw entry id.
  const companyIds = new Set<string>();
  for (const row of rows) {
    if (row.company_id) {companyIds.add(row.company_id);}
  }
  const companyNameMap = await hydrateCompanyNames(
    Array.from(companyIds),
    fieldMaps.company,
  );

  const people = rows
    .filter((row) => row.entry_id)
    .map((row) => {
      const strengthNum = row.strength_score ? Number(row.strength_score) : null;
      return {
        id: String(row.entry_id),
        name: row.name ?? null,
        email: row.email ?? null,
        company_name: row.company_id ? companyNameMap.get(row.company_id) ?? null : null,
        strength_score: Number.isFinite(strengthNum) ? strengthNum : null,
        last_interaction_at: row.last_interaction_at ?? null,
        avatar_url: row.avatar_url ?? null,
        job_title: row.job_title ?? null,
      };
    });

  return Response.json({ people });
}

async function hydrateCompanyNames(
  ids: string[],
  companyFieldMap: Record<string, string>,
): Promise<Map<string, string>> {
  if (ids.length === 0) {return new Map();}
  const nameFieldId = companyFieldMap["Company Name"];
  if (!nameFieldId) {return new Map();}
  const safeIds = ids
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(", ");
  const safeFieldId = nameFieldId.replace(/'/g, "''");
  const sql = `
    SELECT entry_id, value
    FROM entry_fields
    WHERE field_id = '${safeFieldId}'
      AND entry_id IN (${safeIds});
  `;
  const rows = await safeQuery<{ entry_id: string; value: string | null }>(sql);
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.value) {map.set(row.entry_id, row.value);}
  }
  return map;
}
