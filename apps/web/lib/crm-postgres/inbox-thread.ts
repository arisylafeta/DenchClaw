import { queryPg } from "../postgres";

type MessageRow = {
  id: string;
  subject: string | null;
  sent_at: string | Date | null;
  preview: string | null;
  body: string | null;
  has_attachments: boolean | null;
  gmail_message_id: string | null;
  sender_type: string | null;
  from_person_id: string | null;
  to_person_ids: string[] | null;
  cc_person_ids: string[] | null;
};

type PersonRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
};

function iso(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

export async function getPostgresInboxThread(threadId: string) {
  const messages = await queryPg<MessageRow>(`
    select m.id,
           m.subject,
           m.sent_at,
           m.body_preview as preview,
           m.body,
           m.has_attachments,
           m.gmail_message_id,
           sender_type.text_value as sender_type,
           m.from_person_id,
           coalesce(to_people.person_ids, array[]::text[]) as to_person_ids,
           coalesce(cc_people.person_ids, array[]::text[]) as cc_person_ids
      from crm_email_messages m
      left join crm_objects message_object on message_object.name = 'email_message'
      left join crm_fields sender_type_field
        on sender_type_field.object_id = message_object.id
       and sender_type_field.name = 'Sender Type'
      left join crm_custom_field_values sender_type
        on sender_type.entry_id = m.id
       and sender_type.field_id = sender_type_field.id
      left join lateral (
        select array_agg(l.target_entry_id order by l.position, l.target_entry_id) as person_ids
          from crm_relation_links l
          join crm_fields f on f.id = l.field_id
          join crm_objects o on o.id = f.object_id
         where o.name = 'email_message'
           and f.name = 'To'
           and l.source_entry_id = m.id
      ) to_people on true
      left join lateral (
        select array_agg(l.target_entry_id order by l.position, l.target_entry_id) as person_ids
          from crm_relation_links l
          join crm_fields f on f.id = l.field_id
          join crm_objects o on o.id = f.object_id
         where o.name = 'email_message'
           and f.name = 'Cc'
           and l.source_entry_id = m.id
      ) cc_people on true
     where m.thread_id = $1
     order by m.sent_at asc nulls last, m.id
  `, [threadId]);

  const personIds = new Set<string>();
  for (const message of messages) {
    if (message.from_person_id) personIds.add(message.from_person_id);
    for (const id of message.to_person_ids ?? []) personIds.add(id);
    for (const id of message.cc_person_ids ?? []) personIds.add(id);
  }

  const people = personIds.size > 0
    ? await queryPg<PersonRow>(`
        select id,
               full_name as name,
               email,
               avatar_url
          from crm_people
         where id = any($1::text[])
      `, [Array.from(personIds)])
    : [];

  return {
    thread_id: threadId,
    messages: messages.map((message) => ({
      id: message.id,
      subject: message.subject,
      sent_at: iso(message.sent_at),
      preview: message.preview,
      body: message.body,
      has_attachments: Boolean(message.has_attachments),
      gmail_message_id: message.gmail_message_id,
      sender_type: message.sender_type,
      from_person_id: message.from_person_id,
      to_person_ids: message.to_person_ids ?? [],
      cc_person_ids: message.cc_person_ids ?? [],
    })),
    people,
    body_hydration: {
      attempted: 0,
      fetched: 0,
      failed: 0,
      skipped: false,
      rehydrated_plain_text: 0,
    },
  };
}
