import { queryPg } from "../postgres";

export type PostgresPersonActivityParams = {
  personId: string;
  limit: number;
  offset: number;
};

export type PostgresActivityResult = {
  activities: Array<{
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
    } | null;
  }>;
  total: number;
  has_more: boolean;
};

type InteractionRow = {
  id: string;
  type: string | null;
  direction: string | null;
  occurred_at: string | Date | null;
  email_message_id: string | null;
  calendar_event_id: string | null;
  thread_id: string | null;
  subject: string | null;
  body_preview: string | null;
  from_person_id: string | null;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeDirection(value: string | null): "Sent" | "Received" | "Internal" | null {
  if (value === "Sent" || value === "Received" || value === "Internal") return value;
  return null;
}

export async function getPostgresPersonActivity(
  params: PostgresPersonActivityParams,
): Promise<PostgresActivityResult> {
  const personId = params.personId?.trim();
  if (!personId) {
    const err = new Error("Missing person id.");
    (err as Error & { code?: string }).code = "INVALID_INPUT";
    throw err;
  }

  const countRows = await queryPg<{ total: number | string | null }>(
    "select count(*)::bigint as total from crm_interactions where person_id = $1",
    [personId],
  );
  const total = countRows[0]?.total ? Number(countRows[0].total) : 0;
  if (!Number.isFinite(total) || total <= 0) {
    return { activities: [], total: 0, has_more: false };
  }

  const rows = await queryPg<InteractionRow>(
    `select i.id, i.type, i.direction, i.occurred_at, i.email_message_id, i.calendar_event_id,
            m.thread_id, m.subject, m.body_preview, m.from_person_id,
            e.title, e.start_at, e.end_at
       from crm_interactions i
       left join crm_email_messages m on m.id = i.email_message_id
       left join crm_calendar_events e on e.id = i.calendar_event_id
      where i.person_id = $1
      order by i.occurred_at desc nulls last
      limit $2 offset $3`,
    [personId, params.limit, params.offset],
  );

  const fromIds = Array.from(new Set(rows.map((row) => row.from_person_id).filter(Boolean))) as string[];
  const fromPeopleRows = fromIds.length
    ? await queryPg<{ id: string; full_name: string | null; email: string | null; avatar_url: string | null }>(
      "select id, full_name, email, avatar_url from crm_people where id = any($1::text[])",
      [fromIds],
    )
    : [];
  const fromPeople = new Map(fromPeopleRows.map((person) => [person.id, person]));

  const activities = rows.map((row) => {
    const type: "Email" | "Meeting" = row.type === "Meeting" ? "Meeting" : "Email";
    const from = row.from_person_id ? fromPeople.get(row.from_person_id) ?? null : null;
    return {
      id: row.id,
      type,
      direction: normalizeDirection(row.direction),
      occurred_at: iso(row.occurred_at),
      email: type === "Email" && row.email_message_id
        ? {
          id: row.email_message_id,
          thread_id: row.thread_id,
          subject: row.subject,
          snippet: row.body_preview,
          from: from
            ? {
              id: from.id,
              name: from.full_name,
              email: from.email,
              avatar_url: from.avatar_url,
            }
            : null,
        }
        : null,
      event: type === "Meeting" && row.calendar_event_id
        ? {
          id: row.calendar_event_id,
          title: row.title,
          start_at: iso(row.start_at),
          end_at: iso(row.end_at),
        }
        : null,
    };
  });

  return {
    activities,
    total,
    has_more: params.offset + activities.length < total,
  };
}
