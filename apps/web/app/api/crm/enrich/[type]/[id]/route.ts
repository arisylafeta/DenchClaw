import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { getPostgresEnrichmentTarget } from "@/lib/crm-postgres/enrich-target";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Enrich a Person or Company record with data from the Apollo plugin.
 *
 * This is a v1 SCAFFOLD — the actual Apollo tool runs through the
 * OpenClaw plugin API (`extensions/apollo-enrichment/index.ts`) which
 * is callable from the agent runtime, not directly from the web app.
 * Wiring the synchronous web → agent invocation requires the plugin
 * runtime work that's deferred to a later milestone.
 *
 * What this endpoint DOES today:
 *   - Validates the type + id and resolves the target record's email/domain.
 *   - Returns a 501 with `{ ok: false, status: "deferred", hint }` so the
 *     UI can show a "coming soon" toast without breaking anything.
 *
 * What it WILL do later:
 *   - Call the apollo-enrichment plugin tool with the resolved
 *     email/domain, persist the returned fields back into entry_fields,
 *     and respond with the updated record.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ type: string; id: string }> },
) {
  const { type, id } = await ctx.params;
  const trimmedType = type?.trim().toLowerCase();
  const trimmedId = id?.trim();
  if (!trimmedType || !trimmedId) {
    return Response.json({ ok: false, error: "Missing type or id." }, { status: 400 });
  }
  if (trimmedType !== "people" && trimmedType !== "company") {
    return Response.json(
      { ok: false, error: 'Type must be "people" or "company".' },
      { status: 400 },
    );
  }

  let lookupValue: string | null = null;

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const target = await getPostgresEnrichmentTarget(trimmedType, trimmedId);
    lookupValue = target.lookupValue;
  } else {
    const fieldMaps = await loadCrmFieldMaps();

    if (trimmedType === "people") {
      const sql = buildEntryProjection({
        objectId: ONBOARDING_OBJECT_IDS.people,
        fieldMap: fieldMaps.people,
        aliasedFields: [
          { name: "Email Address", alias: "email" },
          { name: "Full Name", alias: "name" },
        ],
        whereSql: `e.id = ${sqlString(trimmedId)}`,
      });
      const rows = await safeQuery<{ email: string | null; name: string | null }>(sql);
      lookupValue = rows[0]?.email ?? null;
    } else {
      const sql = buildEntryProjection({
        objectId: ONBOARDING_OBJECT_IDS.company,
        fieldMap: fieldMaps.company,
        aliasedFields: [
          { name: "Domain", alias: "domain" },
          { name: "Company Name", alias: "name" },
        ],
        whereSql: `e.id = ${sqlString(trimmedId)}`,
      });
      const rows = await safeQuery<{ domain: string | null; name: string | null }>(sql);
      lookupValue = rows[0]?.domain ?? null;
    }
  }

  if (!lookupValue) {
    return Response.json(
      {
        ok: false,
        error:
          trimmedType === "people"
            ? "This contact has no email — Apollo needs an email or LinkedIn URL to enrich."
            : "This company has no domain — Apollo needs a domain to enrich.",
      },
      { status: 400 },
    );
  }

  return Response.json(
    {
      ok: false,
      status: "deferred",
      hint:
        "The Apollo plugin is registered but the synchronous web → plugin invocation pipeline isn't built yet. Track in extensions/apollo-enrichment/ and the plugin runtime work.",
      target: { type: trimmedType, id: trimmedId, lookupValue },
    },
    { status: 501 },
  );
}
