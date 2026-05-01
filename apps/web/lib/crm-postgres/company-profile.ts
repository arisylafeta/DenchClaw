import { getConnectionStrengthBucket } from "../connection-strength-label";
import { queryPg } from "../postgres";
import { deriveDisplayDomain, deriveWebsite } from "../website-from-domain";

export type PostgresCompanyProfile = {
  company: {
    id: string;
    name: string | null;
    domain: string | null;
    website: string | null;
    industry: string | null;
    type: string | null;
    source: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  people: Array<{
    id: string;
    name: string | null;
    email: string | null;
    job_title: string | null;
    strength_score: number | null;
    strength_label: string;
    strength_color: string;
    last_interaction_at: string | null;
    avatar_url: string | null;
  }>;
  threads: Array<{
    id: string;
    subject: string | null;
    last_message_at: string | null;
    message_count: number | null;
    gmail_thread_id: string | null;
    snippet: string | null;
    primary_sender_type: string | null;
    primary_sender_id: string | null;
    primary_sender_name: string | null;
    primary_sender_email: string | null;
    primary_sender_avatar_url: string | null;
  }>;
  events: Array<{
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  }>;
  summary: {
    people_count: number;
    thread_count: number;
    event_count: number;
    strongest_contact: string | null;
  };
};

type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  type: string | null;
  source: string | null;
  strength_score: number | string | null;
  last_interaction_at: string | Date | null;
  notes: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

type PersonRow = {
  id: string;
  name: string | null;
  email: string | null;
  job_title: string | null;
  strength_score: number | string | null;
  last_interaction_at: string | Date | null;
  avatar_url: string | null;
};

type ThreadRow = {
  id: string;
  subject: string | null;
  last_message_at: string | Date | null;
  message_count: number | null;
  gmail_thread_id: string | null;
  snippet: string | null;
  primary_sender_type: string | null;
  primary_sender_id: string | null;
  primary_sender_name: string | null;
  primary_sender_email: string | null;
  primary_sender_avatar_url: string | null;
};

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  meeting_type: string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

export async function getPostgresCompanyProfile(companyId: string): Promise<PostgresCompanyProfile | null> {
  const companyRows = await queryPg<CompanyRow>(`
    select id,
           name,
           domain,
           website,
           coalesce(sector, raw_json->>'Industry') as industry,
           coalesce(company_type, raw_json->>'Type') as type,
           raw_json->>'Source' as source,
           strength_score,
           last_interaction_at,
           raw_json->>'Notes' as notes,
           created_at,
           updated_at
      from crm_companies
     where id = $1
     limit 1
  `, [companyId]);
  const raw = companyRows[0];
  if (!raw) return null;

  const strengthScore = numberOrNull(raw.strength_score) ?? 0;
  const bucket = getConnectionStrengthBucket(strengthScore);
  const company = {
    id: raw.id,
    name: raw.name,
    domain: raw.domain,
    website: raw.website ?? deriveWebsite(raw.domain),
    industry: raw.industry,
    type: raw.type,
    source: raw.source,
    strength_score: Number.isFinite(strengthScore) ? strengthScore : null,
    strength_label: bucket.label,
    strength_color: bucket.color,
    last_interaction_at: iso(raw.last_interaction_at),
    notes: raw.notes,
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };

  const domain = deriveDisplayDomain(company.domain ?? company.website);
  const peopleRows = await queryPg<PersonRow>(`
    select distinct on (coalesce(lower(trim(email)), id))
           id,
           full_name as name,
           email,
           job_title,
           strength_score,
           last_interaction_at,
           avatar_url
      from crm_people
     where company_id = $1
        or ($2::text is not null and lower(split_part(email, '@', 2)) = $2)
        or ($2::text is not null and lower(split_part(email, '@', 2)) like '%.' || $2)
     order by coalesce(lower(trim(email)), id),
              strength_score desc nulls last,
              last_interaction_at desc nulls last
     limit 100
  `, [company.id, domain]);
  const people = peopleRows
    .map((row) => {
      const score = numberOrNull(row.strength_score) ?? 0;
      const personBucket = getConnectionStrengthBucket(score);
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        job_title: row.job_title,
        strength_score: Number.isFinite(score) ? score : null,
        strength_label: personBucket.label,
        strength_color: personBucket.color,
        last_interaction_at: iso(row.last_interaction_at),
        avatar_url: row.avatar_url,
      };
    })
    .sort((a, b) => (b.strength_score ?? 0) - (a.strength_score ?? 0)
      || String(b.last_interaction_at ?? "").localeCompare(String(a.last_interaction_at ?? "")));

  const threads = await queryPg<ThreadRow>(`
    select t.id,
           t.subject,
           t.last_message_at,
           t.message_count,
           t.gmail_thread_id,
           msg.body_preview as snippet,
           case when msg.from_person_id is not null then 'Person' else null end as primary_sender_type,
           msg.from_person_id as primary_sender_id,
           p.full_name as primary_sender_name,
           p.email as primary_sender_email,
           p.avatar_url as primary_sender_avatar_url
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      join crm_email_threads t on t.id = l.source_entry_id
      left join lateral (
        select m.body_preview, m.from_person_id
          from crm_email_messages m
         where m.thread_id = t.id
         order by m.sent_at desc nulls last
         limit 1
      ) msg on true
      left join crm_people p on p.id = msg.from_person_id
     where o.name = 'email_thread'
       and f.name = 'Companies'
       and l.target_entry_id = $1
     order by t.last_message_at desc nulls last
     limit 50
  `, [company.id]);

  const events = await queryPg<EventRow>(`
    select e.id,
           e.title,
           e.start_at,
           e.end_at,
           e.meeting_type
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      join crm_calendar_events e on e.id = l.source_entry_id
     where o.name = 'calendar_event'
       and f.name = 'Companies'
       and l.target_entry_id = $1
     order by e.start_at desc nulls last
     limit 50
  `, [company.id]);

  return {
    company,
    people,
    threads: threads.map((row) => ({
      ...row,
      last_message_at: iso(row.last_message_at),
    })),
    events: events.map((row) => ({
      ...row,
      start_at: iso(row.start_at),
      end_at: iso(row.end_at),
    })),
    summary: {
      people_count: people.length,
      thread_count: threads.length,
      event_count: events.length,
      strongest_contact: people[0]?.name ?? people[0]?.email ?? null,
    },
  };
}
