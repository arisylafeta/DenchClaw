import { queryPg } from "../postgres";

export type PostgresCalendarParams = {
  search: string;
  fromIso: string | null;
  toIso: string | null;
  limit: number;
  offset: number;
};

type Person = { id: string; name: string | null; email: string | null; avatar_url: string | null };
type Company = { id: string; name: string | null; domain: string | null };

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  organizer: string | null;
  organizer_id: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
  attendees: Person[] | null;
  total_count: string | number | null;
};

type EventDetailRow = {
  id: string;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  organizer_id: string | null;
  meeting_type: string | null;
  google_event_id: string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

async function loadPeopleForEvent(eventId: string, fieldName: "Attendees" | "Organizer"): Promise<Person[]> {
  return queryPg<Person>(`
    select p.id,
           p.full_name as name,
           p.email,
           null as avatar_url
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      join crm_people p on p.id = l.target_entry_id
     where o.name = 'calendar_event'
       and f.name = $2
       and l.source_entry_id = $1
     order by l.position, p.full_name nulls last, p.email nulls last
  `, [eventId, fieldName]);
}

async function loadCompaniesForEvent(eventId: string): Promise<Company[]> {
  return queryPg<Company>(`
    select c.id,
           c.name,
           c.domain
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      join crm_companies c on c.id = l.target_entry_id
     where o.name = 'calendar_event'
       and f.name = 'Companies'
       and l.source_entry_id = $1
     order by l.position, c.name nulls last
  `, [eventId]);
}

export async function getPostgresCalendarEvents(params: PostgresCalendarParams) {
  const rows = await queryPg<EventRow>(`
    with filtered as (
      select e.id,
             e.title,
             e.start_at,
             e.end_at,
             e.organizer_person_id as organizer_id,
             organizer.full_name as organizer,
             e.meeting_type,
             e.google_event_id,
             count(*) over () as total_count
        from crm_calendar_events e
        left join crm_people organizer on organizer.id = e.organizer_person_id
       where ($1::text = '' or lower(coalesce(e.title, '')) like '%' || $1 || '%')
         and ($2::timestamptz is null or e.start_at >= $2::timestamptz)
         and ($3::timestamptz is null or e.start_at <= $3::timestamptz)
       order by e.start_at desc nulls last, e.id
       limit $4 offset $5
    )
    select filtered.*,
           coalesce(attendees.attendees, '[]'::jsonb) as attendees
      from filtered
      left join lateral (
        select jsonb_agg(jsonb_build_object(
          'id', p.id,
          'name', p.full_name,
          'email', p.email,
          'avatar_url', null
        ) order by l.position, p.full_name nulls last, p.email nulls last) as attendees
          from crm_relation_links l
          join crm_fields f on f.id = l.field_id
          join crm_objects o on o.id = f.object_id
          join crm_people p on p.id = l.target_entry_id
         where o.name = 'calendar_event'
           and f.name = 'Attendees'
           and l.source_entry_id = filtered.id
      ) attendees on true
     order by filtered.start_at desc nulls last, filtered.id
  `, [params.search.toLowerCase(), params.fromIso, params.toIso, params.limit, params.offset]);

  return {
    events: rows.map((row) => ({
      id: row.id,
      title: row.title,
      start_at: iso(row.start_at),
      end_at: iso(row.end_at),
      organizer: row.organizer,
      meeting_type: row.meeting_type,
      google_event_id: row.google_event_id,
      attendees: row.attendees ?? [],
    })),
    total: rows[0]?.total_count ? Number(rows[0].total_count) : 0,
    limit: params.limit,
    offset: params.offset,
  };
}

export async function getPostgresCalendarEvent(eventId: string) {
  const rows = await queryPg<EventDetailRow>(`
    select id,
           title,
           start_at,
           end_at,
           organizer_person_id as organizer_id,
           meeting_type,
           google_event_id
      from crm_calendar_events
     where id = $1
     limit 1
  `, [eventId]);
  const row = rows[0];
  if (!row) return null;

  const [organizers, attendees, companies] = await Promise.all([
    row.organizer_id ? queryPg<Person>("select id, full_name as name, email, null as avatar_url from crm_people where id = $1 limit 1", [row.organizer_id]) : loadPeopleForEvent(eventId, "Organizer"),
    loadPeopleForEvent(eventId, "Attendees"),
    loadCompaniesForEvent(eventId),
  ]);

  return {
    event: {
      id: row.id,
      title: row.title,
      start_at: iso(row.start_at),
      end_at: iso(row.end_at),
      meeting_type: row.meeting_type,
      google_event_id: row.google_event_id,
    },
    organizer: organizers[0] ?? null,
    attendees,
    companies,
  };
}
