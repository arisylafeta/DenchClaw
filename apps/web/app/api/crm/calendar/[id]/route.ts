import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  hydratePeopleByIds,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { getPostgresCalendarEvent } from "@/lib/crm-postgres/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/crm/calendar/:id
 *
 * Returns the full detail for a single calendar_event entry, hydrating
 * the relation columns (organizer, attendees, companies) so the UI can
 * render names + avatars without N extra round-trips.
 *
 * Shape mirrors the row shape in `apps/web/app/api/crm/calendar/route.ts`
 * but adds organizer + company hydration that the list call doesn't
 * bother with.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const eventId = id?.trim();
  if (!eventId) {
    return Response.json({ error: "Missing event id." }, { status: 400 });
  }

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const data = await getPostgresCalendarEvent(eventId);
    if (!data) {
      return Response.json({ error: "Event not found." }, { status: 404 });
    }
    return Response.json(data);
  }

  const fieldMaps = await loadCrmFieldMaps();

  // ─── 1. Event row ─────────────────────────────────────────────────────
  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.calendar_event,
    fieldMap: fieldMaps.calendar_event,
    aliasedFields: [
      { name: "Title", alias: "title" },
      { name: "Start At", alias: "start_at" },
      { name: "End At", alias: "end_at" },
      { name: "Organizer", alias: "organizer_id" },
      { name: "Attendees", alias: "attendees_json" },
      { name: "Companies", alias: "companies_json" },
      { name: "Meeting Type", alias: "meeting_type" },
      { name: "Google Event ID", alias: "google_event_id" },
    ],
    whereSql: `e.id = ${sqlString(eventId)}`,
  });
  const rows = await safeQuery<Record<string, string | null>>(projection);
  if (rows.length === 0) {
    return Response.json({ error: "Event not found." }, { status: 404 });
  }
  const row = rows[0];

  // ─── 2. Hydrate organizer + attendees in one round-trip ───────────────
  const attendeeIds = parseRelationIds(row.attendees_json);
  const organizerId = row.organizer_id?.trim() ? row.organizer_id.trim() : null;
  const peopleIds = new Set<string>(attendeeIds);
  if (organizerId) {peopleIds.add(organizerId);}

  const personMap = await hydratePeopleByIds(
    Array.from(peopleIds),
    fieldMaps.people,
  );

  const organizer = organizerId ? personMap.get(organizerId) ?? null : null;
  const attendees = attendeeIds
    .map((personId) => personMap.get(personId))
    .filter((p): p is NonNullable<typeof p> => Boolean(p));

  // ─── 3. Hydrate companies ─────────────────────────────────────────────
  const companyIds = parseRelationIds(row.companies_json);
  const companies = await hydrateCompanies(companyIds, fieldMaps.company);

  return Response.json({
    event: {
      id: String(row.entry_id),
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      meeting_type: row.meeting_type,
      google_event_id: row.google_event_id,
    },
    organizer,
    attendees,
    companies,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRelationIds(value: string | null): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      return [trimmed];
    }
  }
  return [trimmed];
}

type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
};

async function hydrateCompanies(
  ids: ReadonlyArray<string>,
  companyFieldMap: Record<string, string>,
): Promise<CompanyRow[]> {
  if (ids.length === 0) {return [];}
  const nameFieldId = companyFieldMap["Company Name"];
  const domainFieldId = companyFieldMap["Domain"];
  if (!nameFieldId && !domainFieldId) {return [];}

  const inList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
  const sql = `
    SELECT
      e.id AS company_id,
      ${nameFieldId ? `MAX(CASE WHEN ef.field_id = '${nameFieldId}' THEN ef.value END)` : "NULL"} AS name,
      ${domainFieldId ? `MAX(CASE WHEN ef.field_id = '${domainFieldId}' THEN ef.value END)` : "NULL"} AS domain
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.company}'
      AND e.id IN (${inList})
    GROUP BY e.id;
  `;
  const rows = await safeQuery<{
    company_id: string;
    name: string | null;
    domain: string | null;
  }>(sql);
  return rows.map((row) => ({
    id: row.company_id,
    name: row.name,
    domain: row.domain,
  }));
}
