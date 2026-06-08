import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  buildEntryProjection,
  loadCrmFieldMaps,
  safeQuery,
} from "@/lib/crm-queries";
import { getPostgresCalendarEvents } from "@/lib/crm-postgres/calendar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  organizer: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
  attendees: Array<{ id: string; name: string | null; email: string | null; avatar_url: string | null }>;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const fromIso = url.searchParams.get("from")?.trim() || null;
  const toIso = url.searchParams.get("to")?.trim() || null;
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  if (process.env.CRM_DB_BACKEND === "postgres") {
    const data = await getPostgresCalendarEvents({ search, fromIso, toIso, limit, offset });
    return Response.json(data);
  }

  const fieldMaps = await loadCrmFieldMaps();

  const projection = buildEntryProjection({
    objectId: ONBOARDING_OBJECT_IDS.calendar_event,
    fieldMap: fieldMaps.calendar_event,
    aliasedFields: [
      { name: "Title", alias: "title" },
      { name: "Start At", alias: "start_at" },
      { name: "End At", alias: "end_at" },
      { name: "Organizer", alias: "organizer" },
      { name: "Meeting Type", alias: "meeting_type" },
      { name: "Google Event ID", alias: "google_event_id" },
      { name: "Attendees", alias: "attendees_json" },
    ],
  });

  let where = "1=1";
  if (search) {
    const safe = search.replace(/'/g, "''");
    where += ` AND LOWER(COALESCE(title, '')) LIKE '%${safe}%'`;
  }
  if (fromIso) {
    const safe = fromIso.replace(/'/g, "''");
    where += ` AND start_at >= '${safe}'`;
  }
  if (toIso) {
    const safe = toIso.replace(/'/g, "''");
    where += ` AND start_at <= '${safe}'`;
  }

  const sql = `
    WITH base AS (${projection})
    SELECT * FROM base
    WHERE ${where}
    ORDER BY start_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset};
  `;
  const countSql = `WITH base AS (${projection}) SELECT COUNT(*) AS total FROM base WHERE ${where};`;

  const [rows, totalRows] = await Promise.all([
    safeQuery<Record<string, string | null>>(sql),
    safeQuery<{ total: number | string | null }>(countSql),
  ]);
  const total = totalRows[0]?.total ? Number(totalRows[0].total) : 0;

  // Hydrate attendees in one round-trip.
  const allPersonIds = new Set<string>();
  const parsed = rows.map((row) => {
    const ids = parseRelationIds(row.attendees_json);
    for (const id of ids) {allPersonIds.add(id);}
    return { row, attendeeIds: ids };
  });

  const peopleNameFieldId = fieldMaps.people["Full Name"];
  const peopleEmailFieldId = fieldMaps.people["Email Address"];
  const peopleAvatarFieldId = fieldMaps.people["Avatar URL"];
  const personById = new Map<string, { id: string; name: string | null; email: string | null; avatar_url: string | null }>();
  if (allPersonIds.size > 0 && (peopleNameFieldId || peopleEmailFieldId)) {
    const inList = Array.from(allPersonIds).map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
    const peopleSql = `
      SELECT
        e.id AS person_id,
        ${peopleNameFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleNameFieldId}' THEN ef.value END)` : "NULL"} AS name,
        ${peopleEmailFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleEmailFieldId}' THEN ef.value END)` : "NULL"} AS email,
        ${peopleAvatarFieldId ? `MAX(CASE WHEN ef.field_id = '${peopleAvatarFieldId}' THEN ef.value END)` : "NULL"} AS avatar_url
      FROM entries e
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.people}'
        AND e.id IN (${inList})
      GROUP BY e.id;
    `;
    const peopleRows = await safeQuery<{
      person_id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>(peopleSql);
    for (const row of peopleRows) {
      personById.set(row.person_id, {
        id: row.person_id,
        name: row.name,
        email: row.email,
        avatar_url: row.avatar_url,
      });
    }
  }

  const events: EventRow[] = parsed.map(({ row, attendeeIds }) => ({
    id: String(row.entry_id),
    title: row.title,
    start_at: row.start_at,
    end_at: row.end_at,
    organizer: row.organizer,
    meeting_type: row.meeting_type,
    google_event_id: row.google_event_id,
    attendees: attendeeIds
      .map((id) => personById.get(id))
      .filter((p): p is { id: string; name: string | null; email: string | null; avatar_url: string | null } => Boolean(p)),
  }));

  return Response.json({ events, total, limit, offset });
}

function clampInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {return fallback;}
  return Math.min(parsed, max);
}

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
