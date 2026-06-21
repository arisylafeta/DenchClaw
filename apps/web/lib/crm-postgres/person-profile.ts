import { extractEmailHost } from "../email-domain";
import { queryPg } from "../postgres";
import { deriveWebsite } from "../website-from-domain";

type PersonRow = {
  id: string;
  name: string | null;
  email: string | null;
  company_id: string | null;
  phone: string | null;
  job_title: string | null;
  linkedin_url: string | null;
  notes: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
};

type CompanyRow = {
  id: string;
  name: string | null;
  domain: string | null;
  website: string | null;
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
};

type EventRow = {
  id: string;
  title: string | null;
  start_at: string | Date | null;
  end_at: string | Date | null;
  google_event_id: string | null;
};

type InteractionSummaryRow = {
  email_count: number | string | null;
  meeting_count: number | string | null;
  total: number | string | null;
  last_outbound_at: string | Date | null;
  last_inbound_at: string | Date | null;
};

export type PostgresPersonProfile = {
  person: {
    id: string;
    name: string | null;
    email: string | null;
    company_name: string | null;
    company_id: string | null;
    phone: string | null;
    job_title: string | null;
    linkedin_url: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  company: CompanyRow | null;
  derived_website: string | null;
  threads: ThreadRow[];
  events: EventRow[];
  interactions_summary: {
    email_count: number;
    meeting_count: number;
    total: number;
    last_outbound_at: string | null;
    last_inbound_at: string | null;
  };
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

async function loadCompany(companyId: string | null, email: string | null): Promise<CompanyRow | null> {
  if (companyId) {
    const rows = await queryPg<CompanyRow>(`
      select id,
             name,
             domain,
             website
        from crm_companies
       where id = $1
       limit 1
    `, [companyId]);
    if (rows[0]) return rows[0];
  }

  const host = email ? extractEmailHost(email) : null;
  if (!host) return null;
  const rows = await queryPg<CompanyRow>(`
    select id,
           name,
           domain,
           website
      from crm_companies
     where lower(domain) = $1
        or $1 like '%.' || lower(domain)
      limit 1
  `, [host]);
  return rows[0] ?? null;
}

export async function getPostgresPersonProfile(personId: string): Promise<PostgresPersonProfile | null> {
  const rows = await queryPg<PersonRow>(`
    select p.id,
           p.full_name as name,
           p.email,
           p.company_id,
           p.phone,
           p.job_title,
           p.linkedin_url,
           p.notes,
           p.created_at,
           p.updated_at
      from crm_people p
     where p.id = $1
     limit 1
  `, [personId]);
  const raw = rows[0];
  if (!raw) return null;

  const company = await loadCompany(raw.company_id, raw.email);
  const person = {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    company_id: raw.company_id,
    company_name: company?.name ?? null,
    phone: raw.phone,
    job_title: raw.job_title,
    linkedin_url: raw.linkedin_url,
    notes: raw.notes,
    created_at: iso(raw.created_at),
    updated_at: iso(raw.updated_at),
  };

  const threads = await queryPg<ThreadRow>(`
    select t.id,
           t.subject,
           t.last_message_at,
           t.message_count,
           t.gmail_thread_id,
           msg.body_preview as snippet,
           case when msg.from_person_id is not null then 'Person' else null end as primary_sender_type,
           msg.from_person_id as primary_sender_id,
            sender.full_name as primary_sender_name,
            sender.email as primary_sender_email
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
      left join crm_people sender on sender.id = msg.from_person_id
     where o.name = 'email_thread'
       and f.name = 'Participants'
       and l.target_entry_id = $1
     order by t.last_message_at desc nulls last
     limit 50
  `, [person.id]);

  const events = await queryPg<EventRow>(`
    select e.id,
           e.title,
           e.start_at,
           e.end_at,
           e.google_event_id
      from crm_relation_links l
      join crm_fields f on f.id = l.field_id
      join crm_objects o on o.id = f.object_id
      join crm_calendar_events e on e.id = l.source_entry_id
     where o.name = 'calendar_event'
       and f.name = 'Attendees'
       and l.target_entry_id = $1
     order by e.start_at desc nulls last
     limit 50
  `, [person.id]);

  const summaryRows = await queryPg<InteractionSummaryRow>(`
    select count(*) as total,
           count(*) filter (where type = 'Email') as email_count,
           count(*) filter (where type = 'Meeting') as meeting_count,
           max(occurred_at) filter (where direction = 'Sent') as last_outbound_at,
           max(occurred_at) filter (where direction = 'Received') as last_inbound_at
      from crm_interactions
     where person_id = $1
  `, [person.id]);
  const summary = summaryRows[0];

  return {
    person,
    company: company
      ? {
          ...company,
          website: company.website ?? deriveWebsite(company.domain ?? null),
        }
      : null,
    derived_website: deriveWebsite(person.email),
    threads: threads.map((row) => ({ ...row, last_message_at: iso(row.last_message_at) })),
    events: events.map((row) => ({
      ...row,
      start_at: iso(row.start_at),
      end_at: iso(row.end_at),
    })),
    interactions_summary: {
      email_count: summary?.email_count ? Number(summary.email_count) : 0,
      meeting_count: summary?.meeting_count ? Number(summary.meeting_count) : 0,
      total: summary?.total ? Number(summary.total) : 0,
      last_outbound_at: iso(summary?.last_outbound_at ?? null),
      last_inbound_at: iso(summary?.last_inbound_at ?? null),
    },
  };
}
