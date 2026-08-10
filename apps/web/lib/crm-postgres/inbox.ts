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
  primary_sender_id: string | null;
  primary_sender_name: string | null;
  primary_sender_email: string | null;
  total_count: number | string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function getPostgresInbox(
  params: PostgresInboxParams,
  mailboxOwnerId: string,
) {
  const senderFilter = VALID_SENDER_FILTERS.has(params.senderFilter) ? params.senderFilter : "person";
  const rows = await queryPg<InboxThreadRow>(`
    with latest_msg as (
      select distinct on (m.thread_id)
             m.thread_id,
             m.body_preview as snippet,
             m.from_person_id,
             m.from_email
        from crm_email_messages m
       where m.thread_id is not null
         and m.mailbox_owner_id = $5::uuid
       order by m.thread_id, m.sent_at desc nulls last, m.id desc
    ),
    filtered as (
      select t.id,
             t.subject,
             t.last_message_at,
             t.message_count,
             t.gmail_thread_id,
             latest_msg.snippet,
             latest_msg.from_person_id as primary_sender_id,
             coalesce(
               sender.full_name,
               case
                 when latest_msg.from_email in ('alex@rebattery.io', 'agjpolglase@gmail.com', 'alexgpolglase@gmail.com', 'apolglaser@gmail.com') then 'Alex Polglase'
                 when latest_msg.from_email in ('ari@rebattery.io', 'ari.sylafeta@gmail.com') then 'Ari Sylafeta'
                 else null
               end
             ) as primary_sender_name,
             coalesce(sender.email, latest_msg.from_email) as primary_sender_email,
             count(*) over () as total_count
        from crm_email_threads t
        left join latest_msg on latest_msg.thread_id = t.id
        left join crm_people sender on sender.id = latest_msg.from_person_id
       where t.mailbox_owner_id = $5::uuid
         and ($1::text = '' or lower(coalesce(t.subject, '')) like '%' || $1::text || '%')
         and ($2::text is null or exists (
           select 1
             from crm_email_thread_participants p
            where p.thread_id = t.id
              and p.person_id = $2::text
         ))
    ),
    page as (
      select *
        from filtered
       order by last_message_at desc nulls last, id
       limit $3 offset $4
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
                  'avatar_url', null
               ) order by participant_link.position, person.id) as participants
          from crm_email_thread_participants participant_link
          join crm_people person on person.id = participant_link.person_id
         where participant_link.thread_id = page.id
      ) participants on true
     order by page.last_message_at desc nulls last, page.id
  `, [
    params.search.toLowerCase(),
    params.personId,
    params.limit,
    params.offset,
    mailboxOwnerId,
  ]);

  const threads = rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    last_message_at: iso(row.last_message_at),
    message_count: row.message_count,
    gmail_thread_id: row.gmail_thread_id,
    participant_ids: row.participant_ids ?? [],
    participants: row.participants ?? [],
    snippet: row.snippet,
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
