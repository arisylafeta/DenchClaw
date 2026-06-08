import { queryPg } from "../postgres";

const VALID_SENDER_FILTERS = new Set(["person", "all", "automated"]);

export type PostgresInboxParams = {
  search: string;
  senderFilter: "person" | "all" | "automated";
  personId: string | null;
  limit: number;
  offset: number;
};

type InboxThreadRow = {
  id: string;
  subject: string | null;
  last_message_at: string | Date | null;
  message_count: number | null;
  gmail_thread_id: string | null;
  participant_ids: string[] | null;
  participants: Array<{
    id: string;
    name: string | null;
    email: string | null;
    avatar_url: string | null;
  }> | null;
  snippet: string | null;
  primary_sender_type: string | null;
  primary_sender_id: string | null;
  primary_sender_name: string | null;
  primary_sender_email: string | null;
  total_count: number | string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function getPostgresInbox(params: PostgresInboxParams) {
  const senderFilter = VALID_SENDER_FILTERS.has(params.senderFilter) ? params.senderFilter : "person";
  const rows = await queryPg<InboxThreadRow>(`
    with latest_msg as (
      select distinct on (m.thread_id)
             m.thread_id,
             m.body_preview as snippet,
             m.from_person_id,
             sender_type.text_value as sender_type
        from crm_email_messages m
        left join crm_objects message_object on message_object.name = 'email_message'
        left join crm_fields sender_type_field
          on sender_type_field.object_id = message_object.id
         and sender_type_field.name = 'Sender Type'
        left join crm_custom_field_values sender_type
          on sender_type.entry_id = m.id
         and sender_type.field_id = sender_type_field.id
       where m.thread_id is not null
       order by m.thread_id, m.sent_at desc nulls last, m.id desc
    ),
    filtered as (
      select t.id,
             t.subject,
             t.last_message_at,
             t.message_count,
             t.gmail_thread_id,
             latest_msg.snippet,
             latest_msg.sender_type as primary_sender_type,
             latest_msg.from_person_id as primary_sender_id,
             sender.full_name as primary_sender_name,
             sender.email as primary_sender_email,
             count(*) over () as total_count
        from crm_email_threads t
        left join latest_msg on latest_msg.thread_id = t.id
        left join crm_people sender on sender.id = latest_msg.from_person_id
       where ($1::text = '' or lower(coalesce(t.subject, '')) like '%' || $1::text || '%')
         and ($2::text is null or exists (
           select 1
             from crm_relation_links participant_link
             join crm_fields participant_field on participant_field.id = participant_link.field_id
             join crm_objects participant_object on participant_object.id = participant_field.object_id
            where participant_object.name = 'email_thread'
              and participant_field.name = 'Participants'
              and participant_link.source_entry_id = t.id
              and participant_link.target_entry_id = $2::text
         ))
         and ($3::text <> 'person' or latest_msg.sender_type is null or latest_msg.sender_type = 'Person')
         and ($3::text <> 'automated' or (latest_msg.sender_type is not null and latest_msg.sender_type <> 'Person'))
    ),
    page as (
      select *
        from filtered
       order by last_message_at desc nulls last, id
       limit $4 offset $5
    )
    select page.*,
           coalesce(participants.participant_ids, array[]::text[]) as participant_ids,
           coalesce(participants.participants, '[]'::jsonb) as participants
      from page
      left join lateral (
        select array_agg(person.id order by participant_link.position, person.id) as participant_ids,
               jsonb_agg(jsonb_build_object(
                 'id', person.id,
                 'name', person.full_name,
                 'email', person.email,
                 'avatar_url', person.avatar_url
               ) order by participant_link.position, person.id) as participants
          from crm_relation_links participant_link
          join crm_fields participant_field on participant_field.id = participant_link.field_id
          join crm_objects participant_object on participant_object.id = participant_field.object_id
          join crm_people person on person.id = participant_link.target_entry_id
         where participant_object.name = 'email_thread'
           and participant_field.name = 'Participants'
           and participant_link.source_entry_id = page.id
      ) participants on true
     order by page.last_message_at desc nulls last, page.id
  `, [params.search.toLowerCase(), params.personId, senderFilter, params.limit, params.offset]);

  const threads = rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    last_message_at: iso(row.last_message_at),
    message_count: row.message_count,
    gmail_thread_id: row.gmail_thread_id,
    participant_ids: row.participant_ids ?? [],
    participants: row.participants ?? [],
    snippet: row.snippet,
    primary_sender_type: row.primary_sender_type,
    primary_sender_id: row.primary_sender_id,
    primary_sender_name: row.primary_sender_name,
    primary_sender_email: row.primary_sender_email,
  }));

  return {
    threads,
    total: rows[0]?.total_count ? Number(rows[0].total_count) : 0,
    limit: params.limit,
    offset: params.offset,
    sender: senderFilter,
  };
}
