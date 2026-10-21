import "server-only";

import type { Demand } from "../bulk-demand";
import { queryPg } from "../postgres";

export type BuyerMail = {
  id: string;
  thread_id: string | null;
  direction: "inbound" | "outbound";
  subject: string | null;
  preview: string | null;
  /** The message text (first 2,000 characters), for opening it in place. */
  body: string | null;
  from_email: string | null;
  at: string;
};

/**
 * The latest one-to-one email with the buyer in the signed-in user's own mailbox: by the demand's email and every
 * CRM person at the buyer company. Campaign sends are left out; the same visibility rule as the company page.
 */
export async function buyerMail(demand: Demand, userId: string | null, limit = 40): Promise<BuyerMail[]> {
  if (!userId) return [];
  return queryPg<BuyerMail>(
    `with emails as (
       select lower(email) as email from crm_people where company_id = $1 and email is not null
       union select lower($2) where $2 is not null
     )
     select m.id::text, m.thread_id::text, m.direction, m.subject, m.body_preview as preview, left(m.body_text, 2000) as body, m.from_email,
       coalesce(m.sent_at, m.created_at)::text as at
     from mail_message m
     where m.crm_visible and m.mailbox_owner_id = $3::uuid and m.campaign_id is null
       and (lower(m.from_email) in (select email from emails) or lower(m.recipient_email) in (select email from emails)
         or exists (select 1 from unnest(m.to_emails) t where lower(t) in (select email from emails)))
     order by coalesce(m.sent_at, m.created_at) desc
     limit $4`,
    [demand.company_id, demand.email, userId, limit],
  );
}
