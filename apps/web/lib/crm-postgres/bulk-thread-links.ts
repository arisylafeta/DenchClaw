import { queryPg } from "../postgres";
import type { ThreadEntry } from "./bulk-offers";

const inboxHref = (threadId: string) => `/?crm=inbox&view=conversations&thread=${encodeURIComponent(threadId)}&crmOnly=false`;

/**
 * The conversation with a listing's own party (the buyer on a demand), from the confirmed email threads and WhatsApp
 * chats labelled with this listing. Mail is the signed-in user's own mailbox, as everywhere else. Null when nothing is
 * labelled yet, so the caller can fall back to the unlabelled buyer mail.
 */
export async function listingConversation(listingId: string, userId: string | null): Promise<ThreadEntry[] | null> {
  const links = await queryPg<{ channel: "mail" | "whatsapp"; thread_id: string }>(
    `select channel, thread_id from crm_bulk_thread_links where bulk_listing_id = $1 and state = 'confirmed' and offer_id is null`, [listingId]);
  if (!links.length) return null;
  const mailThreads = links.filter((l) => l.channel === "mail").map((l) => l.thread_id);
  const chatThreads = links.filter((l) => l.channel === "whatsapp").map((l) => l.thread_id);
  const [mail, chat] = await Promise.all([
    mailThreads.length && userId ? queryPg<{ id: string; direction: "inbound" | "outbound"; subject: string | null; body: string | null; at: string; thread_id: string | null }>(
      `select m.id, m.direction, m.subject, coalesce(left(m.body_text, 2000), m.body_preview) as body, coalesce(m.sent_at, m.created_at)::text as at, m.thread_id
       from mail_message m where m.crm_visible and m.mailbox_owner_id = $2::uuid and m.thread_id = any ($1::text[])
       order by coalesce(m.sent_at, m.created_at) desc limit 120`, [mailThreads, userId]) : [],
    chatThreads.length ? queryPg<{ id: string; direction: "inbound" | "outbound" | null; body: string | null; at: string; who: string | null }>(
      `select wm.id, wm.direction, wm.body, wm.occurred_at::text as at,
         (select p.full_name from whatsapp_identity_link il join crm_people p on p.id = il.person_id where il.identity_id = wt.identity_id and il.valid_to is null order by il.valid_from limit 1) as who
       from whatsapp_message wm join whatsapp_thread wt on wt.account_id = wm.account_id and wt.id = wm.thread_id
       where wm.thread_id = any ($1::text[]) and wm.deleted_at is null and wm.body is not null and wm.occurred_at is not null
       order by wm.occurred_at desc limit 120`, [chatThreads]) : [],
  ]);
  const entries: ThreadEntry[] = [
    ...mail.map((m) => ({ id: `m${m.id}`, channel: "mail" as const, direction: m.direction, title: m.subject ?? "(no subject)", body: m.body, at: m.at, ref: m.thread_id, href: m.thread_id ? inboxHref(m.thread_id) : null })),
    ...chat.map((c) => ({ id: `w${c.id}`, channel: "whatsapp" as const, direction: c.direction, title: c.direction === "outbound" ? "You" : c.who ?? "Them", body: c.body, at: c.at, ref: null, href: null })),
  ];
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
