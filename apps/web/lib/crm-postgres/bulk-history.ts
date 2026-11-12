import "server-only";
import { queryPg } from "../postgres";
import { mailboxScopeSql } from "../mail-scope";
import { readableMail, sortHistory, type HistoryMessage } from "../deal-history-core";

/**
 * One readable history per deal (slice 3, B6): every email on the threads the deal links (its own thread links, its
 * offers' links, and the Relay emails linked to it) and every message in its linked WhatsApp chats, in one time-ordered
 * thread with sender, time and readable text. Only what those links point to is read; mail the user may not see is left
 * out (the same mailbox rule as the inbox).
 */
export async function dealHistory(listingId: string, userId: string): Promise<HistoryMessage[]> {
  const [mail, chat] = await Promise.all([
    queryPg<{ id: string; direction: "inbound" | "outbound"; from_email: string | null; person: string | null; identity_key: string | null;
      subject: string | null; body_text: string | null; body_html: string | null; at: string; thread_id: string }>(
      `select m.id, m.direction, m.from_email, p.full_name as person, m.identity_key, m.subject, m.body_text, m.body_html,
         coalesce(m.sent_at, m.accepted_at, m.created_at)::text as at, m.thread_id
       from mail_message m left join crm_people p on p.id = m.from_person_id
       where m.state in ('received', 'accepted') and ${mailboxScopeSql("m", "$2")} and m.thread_id in (
         select t.thread_id from crm_bulk_thread_links t where t.bulk_listing_id = $1 and t.channel = 'mail' and t.state <> 'rejected'
         union select r.mail_thread_id from relay_item r where r.bulk_listing_id = $1 and r.mail_thread_id is not null)
       order by coalesce(m.sent_at, m.accepted_at, m.created_at) desc limit 200`, [listingId, userId]),
    queryPg<{ id: string; direction: "inbound" | "outbound" | null; body: string | null; at: string; who: string | null; thread_id: string }>(
      `select wm.id, wm.direction, wm.body, wm.occurred_at::text as at, wm.thread_id,
         (select p.full_name from whatsapp_identity_link il join crm_people p on p.id = il.person_id
           where il.identity_id = coalesce(wm.sender_identity_id, wt.identity_id) and il.valid_to is null order by il.valid_from limit 1) as who
       from whatsapp_message wm join whatsapp_thread wt on wt.account_id = wm.account_id and wt.id = wm.thread_id
       where wm.deleted_at is null and wm.body is not null and wm.occurred_at is not null and wm.thread_id in (
         select t.thread_id from crm_bulk_thread_links t where t.bulk_listing_id = $1 and t.channel = 'whatsapp' and t.state <> 'rejected')
       order by wm.occurred_at desc limit 200`, [listingId]),
  ]);
  const ours = (key: string | null, email: string | null) => key === "supply" ? "ReBattery (supply@)" : key === "buy" ? "ReBattery (buy@)"
    : (email ?? "").toLowerCase().startsWith("ari@") ? "Ari" : "Alex";
  return sortHistory([
    ...mail.map((m): HistoryMessage => ({
      id: `m${m.id}`, channel: "mail", direction: m.direction,
      from: m.direction === "outbound" ? ours(m.identity_key, m.from_email) : m.person ?? m.from_email ?? "Unknown sender",
      at: m.at, subject: m.subject, text: readableMail(m.body_text, m.body_html, m.subject),
      href: `/?crm=inbox&view=conversations&thread=${encodeURIComponent(m.thread_id)}&crmOnly=false`,
    })),
    ...chat.map((c): HistoryMessage => ({
      id: `w${c.id}`, channel: "whatsapp", direction: c.direction,
      from: c.direction === "outbound" ? "ReBattery" : c.who ?? "Them", at: c.at, subject: null, text: c.body ?? "",
      href: `/?crm=inbox&view=whatsapp&thread=${encodeURIComponent(c.thread_id)}`,
    })),
  ]);
}
