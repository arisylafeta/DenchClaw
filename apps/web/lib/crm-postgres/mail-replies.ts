/** Shared reply evidence for campaign recipients, counts and engagement. Alias is code-owned SQL. */
export function campaignReplyAtSql(alias: string): string {
  return `coalesce(${alias}.replied_at,
    (select min(reply_event.occurred_at) from mail_event reply_event
      where reply_event.message_id = ${alias}.id and reply_event.type = 'replied'),
    (select min(reply.sent_at) from mail_message reply
      where reply.direction = 'inbound' and ${alias}.accepted_at is not null and reply.sent_at > ${alias}.accepted_at
        and lower(coalesce(reply.from_email, '')) not like '%@rebattery.io'
        and (lower(reply.from_email) = ${alias}.recipient_email or reply.from_person_id = ${alias}.person_id
          or exists (select 1 from crm_people fp where fp.id = reply.from_person_id
            and fp.company_id = coalesce(${alias}.company_id,
              (select sp.company_id from crm_people sp where sp.id = ${alias}.person_id))))))`;
}
