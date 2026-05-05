import {
  ONBOARDING_OBJECT_IDS,
} from "@/lib/workspace-schema-migrations";
import {
  hydratePeopleByIds,
  loadCrmFieldMaps,
  safeQuery,
  sqlString,
} from "@/lib/crm-queries";
import { getPostgresPersonActivity } from "@/lib/crm-postgres/activity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

/**
 * GET /api/crm/people/:id/activity?limit=100&offset=0
 *
 * Returns the timeline of `interaction` rows for this person, hydrated
 * with the parent email_message + calendar_event context that the
 * Activity tab renders. Newest first.
 *
 * Each interaction is one atomic event (per-message-per-counterparty
 * or per-meeting-per-attendee — see strength-score docs); filtering by
 * `interaction.Person = :id` collapses the per-message-per-recipient
 * fan-out to "one row per message I exchanged with this person + one
 * per meeting we both attended", which is the right unit for a
 * per-person feed.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const personId = id?.trim();
  if (!personId) {
    return Response.json({ error: "Missing person id." }, { status: 400 });
  }

  const url = new URL(req.url);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);

  if (process.env.CRM_DB_BACKEND === "postgres") {
    try {
      const activity = await getPostgresPersonActivity({ personId, limit, offset });
      return Response.json(activity);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "INVALID_INPUT") {
        return Response.json({ error: "Missing person id." }, { status: 400 });
      }
      if (code === "NOT_FOUND") {
        return Response.json({ error: "Person not found." }, { status: 404 });
      }
      return Response.json({ error: "Failed to load activity." }, { status: 500 });
    }
  }

  const fieldMaps = await loadCrmFieldMaps();

  const personRelFieldId = fieldMaps.interaction["Person"];
  const typeFieldId = fieldMaps.interaction["Type"];
  const occurredFieldId = fieldMaps.interaction["Occurred At"];
  const directionFieldId = fieldMaps.interaction["Direction"];
  const emailRelFieldId = fieldMaps.interaction["Email"];
  const eventRelFieldId = fieldMaps.interaction["Event"];

  if (!personRelFieldId || !typeFieldId || !occurredFieldId) {
    return Response.json({
      activities: [],
      total: 0,
      has_more: false,
    });
  }

  const safePerson = personId.replace(/'/g, "''");

  // Total count up-front — cheap; lets the client decide whether to
  // render a "Show more" button without fetching the next page.
  const countSql = `
    SELECT COUNT(*) AS total
    FROM entries e
    JOIN entry_fields person_rel ON person_rel.entry_id = e.id
      AND person_rel.field_id = '${personRelFieldId.replace(/'/g, "''")}'
      AND person_rel.value = '${safePerson}'
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.interaction}';
  `;
  const countRows = await safeQuery<{ total: number | string | null }>(countSql);
  const total = countRows[0]?.total ? Number(countRows[0].total) : 0;

  if (total === 0) {
    return Response.json({ activities: [], total: 0, has_more: false });
  }

  // Pivot the requested page of interactions for this person.
  const pivotSelectParts: string[] = [
    `e.id AS interaction_id`,
    `MAX(CASE WHEN ef.field_id = '${typeFieldId.replace(/'/g, "''")}' THEN ef.value END) AS type`,
    `MAX(CASE WHEN ef.field_id = '${occurredFieldId.replace(/'/g, "''")}' THEN ef.value END) AS occurred_at`,
  ];
  if (directionFieldId) {
    pivotSelectParts.push(
      `MAX(CASE WHEN ef.field_id = '${directionFieldId.replace(/'/g, "''")}' THEN ef.value END) AS direction`,
    );
  } else {
    pivotSelectParts.push(`NULL AS direction`);
  }
  if (emailRelFieldId) {
    pivotSelectParts.push(
      `MAX(CASE WHEN ef.field_id = '${emailRelFieldId.replace(/'/g, "''")}' THEN ef.value END) AS email_id`,
    );
  } else {
    pivotSelectParts.push(`NULL AS email_id`);
  }
  if (eventRelFieldId) {
    pivotSelectParts.push(
      `MAX(CASE WHEN ef.field_id = '${eventRelFieldId.replace(/'/g, "''")}' THEN ef.value END) AS event_id`,
    );
  } else {
    pivotSelectParts.push(`NULL AS event_id`);
  }

  const interactionsSql = `
    SELECT * FROM (
      SELECT
        ${pivotSelectParts.join(",\n        ")}
      FROM entries e
      JOIN entry_fields person_rel ON person_rel.entry_id = e.id
        AND person_rel.field_id = '${personRelFieldId.replace(/'/g, "''")}'
        AND person_rel.value = '${safePerson}'
      LEFT JOIN entry_fields ef ON ef.entry_id = e.id
      WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.interaction}'
      GROUP BY e.id
    ) sub
    ORDER BY occurred_at DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset};
  `;
  const interactionRows = await safeQuery<{
    interaction_id: string;
    type: string | null;
    occurred_at: string | null;
    direction: string | null;
    email_id: string | null;
    event_id: string | null;
  }>(interactionsSql);

  if (interactionRows.length === 0) {
    return Response.json({
      activities: [],
      total,
      has_more: offset < total,
    });
  }

  // Collect referenced email/event/person ids for batched hydration.
  const emailIds = new Set<string>();
  const eventIds = new Set<string>();
  for (const row of interactionRows) {
    if (row.email_id) {emailIds.add(row.email_id);}
    if (row.event_id) {eventIds.add(row.event_id);}
  }

  const [emailMap, eventMap] = await Promise.all([
    hydrateEmailMessages(emailIds, fieldMaps.email_message),
    hydrateCalendarEvents(eventIds, fieldMaps.calendar_event),
  ]);

  // Hydrate "from" people for the email rows in one batched call.
  const fromPersonIds = new Set<string>();
  for (const row of emailMap.values()) {
    if (row.from_id) {fromPersonIds.add(row.from_id);}
  }
  const fromPersonMap = await hydratePeopleByIds(
    Array.from(fromPersonIds),
    fieldMaps.people,
  );

  type Activity = {
    id: string;
    type: "Email" | "Meeting";
    direction: "Sent" | "Received" | "Internal" | null;
    occurred_at: string | null;
    email: {
      id: string;
      thread_id: string | null;
      subject: string | null;
      snippet: string | null;
      from: {
        id: string;
        name: string | null;
        email: string | null;
        avatar_url: string | null;
      } | null;
    } | null;
    event: {
      id: string;
      title: string | null;
      start_at: string | null;
      end_at: string | null;
      meeting_type: string | null;
    } | null;
  };

  const activities: Activity[] = interactionRows.map((row) => {
    const direction = normalizeDirection(row.direction);
    const type = row.type === "Meeting" ? "Meeting" : "Email";

    let email: Activity["email"] = null;
    if (type === "Email" && row.email_id) {
      const msg = emailMap.get(row.email_id);
      if (msg) {
        const from = msg.from_id ? fromPersonMap.get(msg.from_id) ?? null : null;
        email = {
          id: msg.id,
          thread_id: msg.thread_id,
          subject: msg.subject,
          snippet: msg.preview,
          from,
        };
      }
    }

    let event: Activity["event"] = null;
    if (type === "Meeting" && row.event_id) {
      const ev = eventMap.get(row.event_id);
      if (ev) {
        event = {
          id: ev.id,
          title: ev.title,
          start_at: ev.start_at,
          end_at: ev.end_at,
          meeting_type: ev.meeting_type,
        };
      }
    }

    return {
      id: row.interaction_id,
      type,
      direction,
      occurred_at: row.occurred_at,
      email,
      event,
    };
  });

  return Response.json({
    activities,
    total,
    has_more: offset + activities.length < total,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(raw: string | null, fallback: number, max: number): number {
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {return fallback;}
  return Math.min(parsed, max);
}

function normalizeDirection(value: string | null): "Sent" | "Received" | "Internal" | null {
  if (value === "Sent" || value === "Received" || value === "Internal") {return value;}
  return null;
}

type EmailMessageRow = {
  id: string;
  subject: string | null;
  preview: string | null;
  from_id: string | null;
  thread_id: string | null;
};

async function hydrateEmailMessages(
  ids: ReadonlySet<string>,
  fieldMap: Record<string, string>,
): Promise<Map<string, EmailMessageRow>> {
  const out = new Map<string, EmailMessageRow>();
  if (ids.size === 0) {return out;}
  const subjectFieldId = fieldMap["Subject"];
  const previewFieldId = fieldMap["Body Preview"];
  const fromFieldId = fieldMap["From"];
  const threadFieldId = fieldMap["Thread"];
  if (!subjectFieldId && !previewFieldId && !fromFieldId && !threadFieldId) {
    return out;
  }

  const inList = Array.from(ids).map((eid) => sqlString(eid)).join(", ");
  const sql = `
    SELECT
      e.id AS msg_id,
      ${subjectFieldId ? `MAX(CASE WHEN ef.field_id = '${subjectFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS subject,
      ${previewFieldId ? `MAX(CASE WHEN ef.field_id = '${previewFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS preview,
      ${fromFieldId ? `MAX(CASE WHEN ef.field_id = '${fromFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS from_id,
      ${threadFieldId ? `MAX(CASE WHEN ef.field_id = '${threadFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS thread_id
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.email_message}'
      AND e.id IN (${inList})
    GROUP BY e.id;
  `;
  const rows = await safeQuery<{
    msg_id: string;
    subject: string | null;
    preview: string | null;
    from_id: string | null;
    thread_id: string | null;
  }>(sql);
  for (const row of rows) {
    out.set(row.msg_id, {
      id: row.msg_id,
      subject: row.subject,
      preview: row.preview,
      from_id: row.from_id ?? null,
      thread_id: row.thread_id ?? null,
    });
  }
  return out;
}

type CalendarEventRow = {
  id: string;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  meeting_type: string | null;
};

async function hydrateCalendarEvents(
  ids: ReadonlySet<string>,
  fieldMap: Record<string, string>,
): Promise<Map<string, CalendarEventRow>> {
  const out = new Map<string, CalendarEventRow>();
  if (ids.size === 0) {return out;}
  const titleFieldId = fieldMap["Title"];
  const startFieldId = fieldMap["Start At"];
  const endFieldId = fieldMap["End At"];
  const meetingTypeFieldId = fieldMap["Meeting Type"];
  if (!titleFieldId && !startFieldId && !endFieldId && !meetingTypeFieldId) {
    return out;
  }

  const inList = Array.from(ids).map((eid) => sqlString(eid)).join(", ");
  const sql = `
    SELECT
      e.id AS evt_id,
      ${titleFieldId ? `MAX(CASE WHEN ef.field_id = '${titleFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS title,
      ${startFieldId ? `MAX(CASE WHEN ef.field_id = '${startFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS start_at,
      ${endFieldId ? `MAX(CASE WHEN ef.field_id = '${endFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS end_at,
      ${meetingTypeFieldId ? `MAX(CASE WHEN ef.field_id = '${meetingTypeFieldId.replace(/'/g, "''")}' THEN ef.value END)` : "NULL"} AS meeting_type
    FROM entries e
    LEFT JOIN entry_fields ef ON ef.entry_id = e.id
    WHERE e.object_id = '${ONBOARDING_OBJECT_IDS.calendar_event}'
      AND e.id IN (${inList})
    GROUP BY e.id;
  `;
  const rows = await safeQuery<{
    evt_id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  }>(sql);
  for (const row of rows) {
    out.set(row.evt_id, {
      id: row.evt_id,
      title: row.title,
      start_at: row.start_at,
      end_at: row.end_at,
      meeting_type: row.meeting_type,
    });
  }
  return out;
}
