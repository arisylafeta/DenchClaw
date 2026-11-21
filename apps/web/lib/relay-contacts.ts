import "server-only";
import { queryPg } from "./postgres";

/** Someone Alex can address: from the CRM and from the mail he has sent and received. */
export type Contact = { email: string; name: string | null; company: string | null; emails: number };

const READ_STATES = "('received','accepted','sent','delivered','opened','clicked','replied')";

/**
 * Address autocomplete, like Gmail's: people whose address, name or company matches what Alex typed, the ones he writes
 * to most and most lately first, and a match at the start of the address or name before one in the middle.
 * One-to-one mail only (no campaigns or system mail). At most `limit`.
 */
export async function searchContacts(typed: string, limit = 8): Promise<Contact[]> {
  const q = typed.trim().toLowerCase().replace(/[\\%_]/g, "\\$&");
  if (q.length < 2) return [];
  return queryPg<Contact>(
    `with seen as (
       select lower(trim(a)) as email, count(*)::int as n, max(coalesce(m.sent_at, m.accepted_at, m.created_at)) as last
       from mail_message m, unnest(array[m.from_email] || coalesce(m.to_emails, '{}') || coalesce(m.cc_emails, '{}')) a
       where m.campaign_id is null and coalesce(m.purpose, '') not in ('marketing', 'transactional') and m.state in ${READ_STATES}
         and (m.from_email ilike $1 or array_to_string(m.to_emails, ' ') ilike $1 or array_to_string(m.cc_emails, ' ') ilike $1)
         and a ilike $1
       group by 1),
     people as (
       select distinct on (lower(trim(p.email))) lower(trim(p.email)) as email, p.full_name as name, c.name as company
       from crm_people p left join crm_companies c on c.id = p.company_id
       where p.email is not null and (p.email ilike $1 or p.full_name ilike $1 or c.name ilike $1)
       order by lower(trim(p.email)), p.updated_at desc nulls last
       limit 300),
     joined as (
       select coalesce(s.email, p.email) as email, nullif(trim(p.name), '') as name, p.company, coalesce(s.n, 0) as n, s.last
       from seen s full join people p on p.email = s.email)
     select email, name, company, n as emails from joined
     where email ~ '^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$' and email not like 'no-reply%' and email not like 'noreply%'
     order by (email like $2 or lower(coalesce(name, '')) like $2 or lower(coalesce(name, '')) like $3) desc,
       n / (1 + extract(epoch from now() - coalesce(last, now() - interval '3 years')) / 2592000.0) desc, n desc, email
     limit $4`,
    [`%${q}%`, `${q}%`, `% ${q}%`, limit]);
}
