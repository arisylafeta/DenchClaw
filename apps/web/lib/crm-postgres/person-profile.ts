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
  last_interaction_at: string | Date | null;
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

type CampaignSendRow = {
  send_id: string;
  campaign_id: string;
  campaign_name: string;
  listing_id: string;
  recipient_email: string;
  state: string;
  accepted_at: string | Date | null;
  delivered_at: string | Date | null;
  bounced_at: string | Date | null;
  provider_opened_at: string | Date | null;
  provider_link_clicked_at: string | Date | null;
  last_synced_at: string | Date | null;
  pitch_count: number | string;
};

type CampaignLinkRow = {
  send_id: string;
  cta_key: string;
  listing_id: string | null;
  first_clicked_at: string | Date | null;
};

type CampaignLink = {
  cta_key: string;
  listing_id: string | null;
  first_clicked_at: string | null;
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
    last_interaction_at: string | null;
    created_at: string | null;
    updated_at: string | null;
  };
  company: CompanyRow | null;
  derived_website: string | null;
  threads: ThreadRow[];
  events: EventRow[];
  campaigns: Array<Omit<CampaignSendRow, "pitch_count" | "accepted_at" | "delivered_at" | "bounced_at" | "provider_opened_at" | "provider_link_clicked_at" | "last_synced_at"> & {
    pitch_count: number;
    accepted_at: string | null;
    delivered_at: string | null;
    bounced_at: string | null;
    provider_opened_at: string | null;
    provider_link_clicked_at: string | null;
    last_synced_at: string | null;
    links: CampaignLink[];
  }>;
  campaign_summary: {
    sent: number;
    delivered: number;
    opened: number;
    clicked: number;
    tracking_pending: number;
  };
  listing_engagement: Array<{
    listing_id: string;
    cta_key: string;
    clicked_updates: number;
  }>;
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

export async function getPostgresPersonProfile(
  personId: string,
  userId = "",
): Promise<PostgresPersonProfile | null> {
  const rows = await queryPg<PersonRow>(`
    select p.id,
           p.full_name as name,
           p.email,
           p.company_id,
            p.phone,
            p.job_title,
            p.linkedin_url,
            p.last_interaction_at,
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
    last_interaction_at: iso(raw.last_interaction_at),
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
           and m.mailbox_owner_id = $2::uuid
         order by m.sent_at desc nulls last
         limit 1
      ) msg on true
      left join crm_people sender on sender.id = msg.from_person_id
     where o.name = 'email_thread'
       and f.name = 'Participants'
       and l.target_entry_id = $1
       and t.mailbox_owner_id = $2::uuid
     order by t.last_message_at desc nulls last
     limit 50
  `, [person.id, userId]);

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

  const campaignTable = await queryPg<{ available: boolean; links_available: boolean }>(
    `select to_regclass('crm_campaign_sends') is not null as available,
            to_regclass('crm_campaign_send_links') is not null as links_available`,
  );
  const campaignRows = campaignTable[0]?.available ? await queryPg<CampaignSendRow>(`
    select s.id as send_id, s.campaign_id, c.campaign_name, s.listing_id, s.recipient_email,
           s.state, s.accepted_at, s.delivered_at, s.bounced_at,
           s.provider_opened_at, s.provider_link_clicked_at, s.last_synced_at,
           count(*) filter (where s.accepted_at is not null) over (partition by s.person_id, s.listing_id) as pitch_count
      from crm_campaign_sends s join campaigns c on c.id = s.campaign_id
     where s.person_id = $1
     order by s.created_at desc
  `, [person.id]) : [];
  const linkRows = campaignTable[0]?.available && campaignTable[0]?.links_available
    ? await queryPg<CampaignLinkRow>(`
      select l.send_id, l.cta_key, l.listing_id, l.first_clicked_at
        from crm_campaign_send_links l
        join crm_campaign_sends s on s.id = l.send_id
       where s.person_id = $1
       order by l.cta_key
    `, [person.id])
    : [];
  const linksBySend = new Map<string, CampaignLink[]>();
  for (const row of linkRows) {
    const links = linksBySend.get(row.send_id) ?? [];
    links.push({
      cta_key: row.cta_key,
      listing_id: row.listing_id,
      first_clicked_at: iso(row.first_clicked_at),
    });
    linksBySend.set(row.send_id, links);
  }

  const campaignSummary = { sent: 0, delivered: 0, opened: 0, clicked: 0, tracking_pending: 0 };
  const listingEngagement = new Map<string, PostgresPersonProfile["listing_engagement"][number]>();
  for (const row of campaignRows) {
    if (!row.accepted_at) continue;
    campaignSummary.sent += 1;
    if (row.delivered_at) campaignSummary.delivered += 1;
    if (row.provider_opened_at) campaignSummary.opened += 1;
    if (!row.last_synced_at) campaignSummary.tracking_pending += 1;

    const links = linksBySend.get(row.send_id) ?? [];
    if (row.provider_link_clicked_at || links.some((link) => link.first_clicked_at)) {
      campaignSummary.clicked += 1;
    }
    const clickedListings = new Set<string>();
    for (const link of links) {
      if (!link.listing_id || !link.first_clicked_at || clickedListings.has(link.listing_id)) continue;
      clickedListings.add(link.listing_id);
      const engagement = listingEngagement.get(link.listing_id);
      if (engagement) {
        engagement.clicked_updates += 1;
      } else {
        listingEngagement.set(link.listing_id, {
          listing_id: link.listing_id,
          cta_key: link.cta_key,
          clicked_updates: 1,
        });
      }
    }
  }

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
    campaigns: campaignRows.map((row) => ({
      ...row,
      pitch_count: Number(row.pitch_count),
      accepted_at: iso(row.accepted_at),
      delivered_at: iso(row.delivered_at),
      bounced_at: iso(row.bounced_at),
      provider_opened_at: iso(row.provider_opened_at),
      provider_link_clicked_at: iso(row.provider_link_clicked_at),
      last_synced_at: iso(row.last_synced_at),
      links: linksBySend.get(row.send_id) ?? [],
    })),
    campaign_summary: campaignSummary,
    listing_engagement: [...listingEngagement.values()],
    interactions_summary: {
      email_count: summary?.email_count ? Number(summary.email_count) : 0,
      meeting_count: summary?.meeting_count ? Number(summary.meeting_count) : 0,
      total: summary?.total ? Number(summary.total) : 0,
      last_outbound_at: iso(summary?.last_outbound_at ?? null),
      last_inbound_at: iso(summary?.last_inbound_at ?? null),
    },
  };
}
