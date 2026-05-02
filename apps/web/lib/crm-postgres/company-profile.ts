import { getConnectionStrengthBucket } from "../connection-strength-label";
import { queryPg } from "../postgres";
import { deriveDisplayDomain, deriveWebsite } from "../website-from-domain";

export type CommercialProfile = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  profile_type: "buyer_demand" | "seller_supply" | "recycler_intake";
  status: "active" | "paused" | "unverified" | "archived";
  battery_types: string[];
  previous_applications: string[];
  chemistries: string[];
  conditions: string[];
  formats: string[];
  specific_types: string[];
  geographies: string[];
  soh_floor: number | null;
  volume_min: number | null;
  volume_max: number | null;
  preferred_outcome: string | null;
  notes: string | null;
  source: string | null;
  last_verified_at: string | null;
};

export type CommercialOpportunity = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  opportunity_type: "supply" | "demand";
  status: "draft" | "open" | "matched" | "closed" | "expired" | "cancelled";
  source_system: "crm" | "supabase" | "csv" | "email";
  source_id: string | null;
  title: string;
  battery_type: string | null;
  previous_application: string | null;
  chemistry: string | null;
  condition: string | null;
  format: string | null;
  manufacturer: string | null;
  model: string | null;
  specific_type: string | null;
  location_country: string | null;
  location_region: string | null;
  quantity: number | null;
  soh: number | null;
  pack_kwh: number | null;
  price_amount: number | null;
  currency: string | null;
  urgency: "low" | "medium" | "high" | "critical";
  priority_score: number | null;
  available_from: string | null;
  deadline_at: string | null;
  last_synced_at: string | null;
  notes: string | null;
};

export type CommercialSummary = {
  active_profile_count: number;
  buyer_profile_count: number;
  supplier_profile_count: number;
  recycler_profile_count: number;
  open_supply_count: number;
  open_demand_count: number;
  urgent_supply_count: number;
  urgent_demand_count: number;
  latest_profile_verified_at: string | null;
  latest_supply_at: string | null;
  latest_demand_at: string | null;
  next_deadline_at: string | null;
  commercial_status: "supply_and_demand" | "active_supply" | "active_demand" | "profile_only" | "inactive";
  commercial_priority_score: number;
};

export type CompanyCommercial = {
  roles: Array<"buyer" | "supplier" | "recycler">;
  profiles: CommercialProfile[];
  opportunities: CommercialOpportunity[];
  summary: CommercialSummary;
};

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
  commercial: CompanyCommercial;
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

type CommercialProfileRow = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  profile_type: CommercialProfile["profile_type"];
  status: CommercialProfile["status"];
  battery_types: string[] | null;
  previous_applications: string[] | null;
  chemistries: string[] | null;
  conditions: string[] | null;
  formats: string[] | null;
  specific_types: string[] | null;
  geographies: string[] | null;
  soh_floor: number | string | null;
  volume_min: number | string | null;
  volume_max: number | string | null;
  preferred_outcome: string | null;
  notes: string | null;
  source: string | null;
  last_verified_at: string | Date | null;
};

type CommercialOpportunityRow = {
  id: string;
  company_id: string;
  contact_person_id: string | null;
  contact_person_name: string | null;
  opportunity_type: CommercialOpportunity["opportunity_type"];
  status: CommercialOpportunity["status"];
  source_system: CommercialOpportunity["source_system"];
  source_id: string | null;
  title: string;
  battery_type: string | null;
  previous_application: string | null;
  chemistry: string | null;
  condition: string | null;
  format: string | null;
  manufacturer: string | null;
  model: string | null;
  specific_type: string | null;
  location_country: string | null;
  location_region: string | null;
  quantity: number | string | null;
  soh: number | string | null;
  pack_kwh: number | string | null;
  price_amount: number | string | null;
  currency: string | null;
  urgency: CommercialOpportunity["urgency"];
  priority_score: number | string | null;
  available_from: string | Date | null;
  deadline_at: string | Date | null;
  last_synced_at: string | Date | null;
  notes: string | null;
};

type CommercialSummaryRow = {
  active_profile_count: number | string | null;
  buyer_profile_count: number | string | null;
  supplier_profile_count: number | string | null;
  recycler_profile_count: number | string | null;
  open_supply_count: number | string | null;
  open_demand_count: number | string | null;
  urgent_supply_count: number | string | null;
  urgent_demand_count: number | string | null;
  latest_profile_verified_at: string | Date | null;
  latest_supply_at: string | Date | null;
  latest_demand_at: string | Date | null;
  next_deadline_at: string | Date | null;
  commercial_status: CommercialSummary["commercial_status"] | null;
  commercial_priority_score: number | string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) { return null; }
  return value instanceof Date ? value.toISOString() : value;
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null || value === "") { return null; }
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
  if (!raw) { return null; }

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
    .toSorted((a, b) => (b.strength_score ?? 0) - (a.strength_score ?? 0)
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

  const profileRows = await queryPg<CommercialProfileRow>(`
    select cp.id,
           cp.company_id,
           cp.contact_person_id,
           p.full_name as contact_person_name,
           cp.profile_type,
           cp.status,
           cp.battery_types,
           cp.previous_applications,
           cp.chemistries,
           cp.conditions,
           cp.formats,
           cp.specific_types,
           cp.geographies,
           cp.soh_floor,
           cp.volume_min,
           cp.volume_max,
           cp.preferred_outcome,
           cp.notes,
           cp.source,
           cp.last_verified_at
      from crm_commercial_profiles cp
      left join crm_people p on p.id = cp.contact_person_id
     where cp.company_id = $1
     order by case when cp.status = 'active' then 0 else 1 end,
              cp.profile_type asc,
              cp.last_verified_at desc nulls last,
              cp.created_at desc
  `, [company.id]);

  const opportunityRows = await queryPg<CommercialOpportunityRow>(`
    select co.id,
           co.company_id,
           co.contact_person_id,
           p.full_name as contact_person_name,
           co.opportunity_type,
           co.status,
           co.source_system,
           co.source_id,
           co.title,
           co.battery_type,
           co.previous_application,
           co.chemistry,
           co.condition,
           co.format,
           co.manufacturer,
           co.model,
           co.specific_type,
           co.location_country,
           co.location_region,
           co.quantity,
           co.soh,
           co.pack_kwh,
           co.price_amount,
           co.currency,
           co.urgency,
           co.priority_score,
           co.available_from,
           co.deadline_at,
           co.last_synced_at,
           co.notes
      from crm_commercial_opportunities co
      left join crm_people p on p.id = co.contact_person_id
     where co.company_id = $1
     order by case when co.status = 'open' then 0 else 1 end,
              case co.urgency
                when 'critical' then 0
                when 'high' then 1
                when 'medium' then 2
                when 'low' then 3
                else 4
              end,
              co.deadline_at asc nulls last,
              co.created_at desc
     limit 200
  `, [company.id]);

  const summaryRows = await queryPg<CommercialSummaryRow>(`
    select active_profile_count,
           buyer_profile_count,
           supplier_profile_count,
           recycler_profile_count,
           open_supply_count,
           open_demand_count,
           urgent_supply_count,
           urgent_demand_count,
           latest_profile_verified_at,
           latest_supply_at,
           latest_demand_at,
           next_deadline_at,
           commercial_status,
           commercial_priority_score
      from crm_company_commercial_summary_v
     where company_id = $1
     limit 1
  `, [company.id]);

  const fallbackSummary: CommercialSummary = {
    active_profile_count: 0,
    buyer_profile_count: 0,
    supplier_profile_count: 0,
    recycler_profile_count: 0,
    open_supply_count: 0,
    open_demand_count: 0,
    urgent_supply_count: 0,
    urgent_demand_count: 0,
    latest_profile_verified_at: null,
    latest_supply_at: null,
    latest_demand_at: null,
    next_deadline_at: null,
    commercial_status: "inactive",
    commercial_priority_score: 0,
  };

  const commercialSummary: CommercialSummary = summaryRows[0]
    ? {
      active_profile_count: numberOrNull(summaryRows[0].active_profile_count) ?? 0,
      buyer_profile_count: numberOrNull(summaryRows[0].buyer_profile_count) ?? 0,
      supplier_profile_count: numberOrNull(summaryRows[0].supplier_profile_count) ?? 0,
      recycler_profile_count: numberOrNull(summaryRows[0].recycler_profile_count) ?? 0,
      open_supply_count: numberOrNull(summaryRows[0].open_supply_count) ?? 0,
      open_demand_count: numberOrNull(summaryRows[0].open_demand_count) ?? 0,
      urgent_supply_count: numberOrNull(summaryRows[0].urgent_supply_count) ?? 0,
      urgent_demand_count: numberOrNull(summaryRows[0].urgent_demand_count) ?? 0,
      latest_profile_verified_at: iso(summaryRows[0].latest_profile_verified_at),
      latest_supply_at: iso(summaryRows[0].latest_supply_at),
      latest_demand_at: iso(summaryRows[0].latest_demand_at),
      next_deadline_at: iso(summaryRows[0].next_deadline_at),
      commercial_status: summaryRows[0].commercial_status ?? "inactive",
      commercial_priority_score: numberOrNull(summaryRows[0].commercial_priority_score) ?? 0,
    }
    : fallbackSummary;

  const roles: CompanyCommercial["roles"] = [];
  if (commercialSummary.buyer_profile_count > 0 || commercialSummary.open_demand_count > 0) { roles.push("buyer"); }
  if (commercialSummary.supplier_profile_count > 0 || commercialSummary.open_supply_count > 0) { roles.push("supplier"); }
  if (commercialSummary.recycler_profile_count > 0) { roles.push("recycler"); }

  const commercial: CompanyCommercial = {
    roles,
    profiles: profileRows.map((row) => ({
      id: row.id,
      company_id: row.company_id,
      contact_person_id: row.contact_person_id,
      contact_person_name: row.contact_person_name,
      profile_type: row.profile_type,
      status: row.status,
      battery_types: row.battery_types ?? [],
      previous_applications: row.previous_applications ?? [],
      chemistries: row.chemistries ?? [],
      conditions: row.conditions ?? [],
      formats: row.formats ?? [],
      specific_types: row.specific_types ?? [],
      geographies: row.geographies ?? [],
      soh_floor: numberOrNull(row.soh_floor),
      volume_min: numberOrNull(row.volume_min),
      volume_max: numberOrNull(row.volume_max),
      preferred_outcome: row.preferred_outcome,
      notes: row.notes,
      source: row.source,
      last_verified_at: iso(row.last_verified_at),
    })),
    opportunities: opportunityRows.map((row) => ({
      id: row.id,
      company_id: row.company_id,
      contact_person_id: row.contact_person_id,
      contact_person_name: row.contact_person_name,
      opportunity_type: row.opportunity_type,
      status: row.status,
      source_system: row.source_system,
      source_id: row.source_id,
      title: row.title,
      battery_type: row.battery_type,
      previous_application: row.previous_application,
      chemistry: row.chemistry,
      condition: row.condition,
      format: row.format,
      manufacturer: row.manufacturer,
      model: row.model,
      specific_type: row.specific_type,
      location_country: row.location_country,
      location_region: row.location_region,
      quantity: numberOrNull(row.quantity),
      soh: numberOrNull(row.soh),
      pack_kwh: numberOrNull(row.pack_kwh),
      price_amount: numberOrNull(row.price_amount),
      currency: row.currency,
      urgency: row.urgency,
      priority_score: numberOrNull(row.priority_score),
      available_from: iso(row.available_from),
      deadline_at: iso(row.deadline_at),
      last_synced_at: iso(row.last_synced_at),
      notes: row.notes,
    })),
    summary: commercialSummary,
  };

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
    commercial,
  };
}
