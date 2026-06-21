import { queryPg } from "../postgres";

type MessageRow = {
  id: string;
  subject: string | null;
  sent_at: string | Date | null;
  preview: string | null;
  body: string | null;
  has_attachments: boolean | null;
  gmail_message_id: string | null;
  from_person_id: string | null;
  from_email: string | null;
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

const OWNER_NAMES: Record<string, string> = {
  "alex@rebattery.io": "Alex Polglase",
  "agjpolglase@gmail.com": "Alex Polglase",
  "alexgpolglase@gmail.com": "Alex Polglase",
  "apolglaser@gmail.com": "Alex Polglase",
  "ari@rebattery.io": "Ari Sylafeta",
  "ari.sylafeta@gmail.com": "Ari Sylafeta",
};

export async function getPostgresInboxThread(threadId: string) {
  const messages = await queryPg<MessageRow>(`
    select m.id,
           m.subject,
           m.sent_at,
           m.body_preview as preview,
           m.body,
           m.has_attachments,
           m.gmail_message_id,
           m.from_person_id,
           m.from_email,
           coalesce(to_people.person_ids, array[]::text[]) as to_person_ids,
           coalesce(cc_people.person_ids, array[]::text[]) as cc_person_ids
      from crm_email_messages m
      left join lateral (
        select array_agg(r.person_id order by r.position, r.person_id) as person_ids
          from crm_email_message_recipients r
         where r.message_id = m.id
           and r.recipient_type = 'to'
      ) to_people on true
      left join lateral (
        select array_agg(r.person_id order by r.position, r.person_id) as person_ids
          from crm_email_message_recipients r
         where r.message_id = m.id
           and r.recipient_type = 'cc'
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
               null as avatar_url
          from crm_people
         where id = any($1::text[])
      `, [Array.from(personIds)])
    : [];

  // Build a lookup that includes owner emails resolved to names
  const personById = new Map(people.map((p) => [p.id, p]));

  return {
    thread_id: threadId,
    messages: messages.map((message) => {
      const fromPerson = message.from_person_id
        ? personById.get(message.from_person_id)
        : undefined;
      const fromName = fromPerson?.name
        ?? (message.from_email ? OWNER_NAMES[message.from_email] : undefined)
        ?? null;
      const fromEmail = fromPerson?.email ?? message.from_email ?? null;

      return {
        id: message.id,
        subject: message.subject,
        sent_at: iso(message.sent_at),
        preview: message.preview,
        body: message.body,
        has_attachments: Boolean(message.has_attachments),
        gmail_message_id: message.gmail_message_id,
        from_person_id: message.from_person_id,
        from_name: fromName,
        from_email: fromEmail,
        to_person_ids: message.to_person_ids ?? [],
        cc_person_ids: message.cc_person_ids ?? [],
      };
    }),
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
