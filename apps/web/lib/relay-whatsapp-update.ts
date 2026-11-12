import "server-only";
import { queryPg } from "./postgres";
import { DEAL_NOTE } from "./relay-deal";
import { AUTO_DEAL_UPDATE_DAYS, autoDealUpdateOn } from "./relay-front-door";

/**
 * A new inbound message in a WhatsApp chat linked to an open deal queues the same "Update deal from this reply" job as an
 * email reply does (queueReplyUpdates in relay-deal.ts): context for the deal only. It never drafts or sends a WhatsApp
 * reply. The job runs through a Relay email on the deal (relay_job needs one); a deal with no Relay email is left alone.
 *
 * Built and tested, NOT wired: the WhatsApp ingestion (scripts/rebattery/rebattery_whatsapp/ingest.py) has no hook this
 * slice may change. To wire it, call queueWhatsAppUpdates from the scan follow-up (relay.ts scanFollowUp) with a start
 * function that hands the message text to startDealJob in place of the email.
 */

export type WhatsAppUpdate = { listing_id: string; item_id: string; message_id: string; thread_id: string; at: string; text: string };

/** Linked chats whose newest message is theirs, recent, and newer than the deal's last deal job: one per deal. */
export async function whatsAppUpdatesDue(ownerId: string): Promise<WhatsAppUpdate[]> {
  return queryPg<WhatsAppUpdate>(
    `select distinct on (t.bulk_listing_id) t.bulk_listing_id as listing_id, i.id as item_id, w.id as message_id, w.thread_id, w.occurred_at::text as at, coalesce(w.body, '') as text
     from crm_bulk_thread_links t
     join crm_bulk_listings b on b.id = t.bulk_listing_id and b.status <> 'closed'
     join lateral (select m.id, m.thread_id, m.direction, m.occurred_at, m.body from whatsapp_message m
        where m.thread_id = t.thread_id and m.deleted_at is null and m.occurred_at is not null order by m.occurred_at desc, m.id desc limit 1) w on true
     join lateral (select r.id from relay_item r where r.bulk_listing_id = t.bulk_listing_id and r.owner_id = $1::uuid order by r.updated_at desc limit 1) i on true
     where t.channel = 'whatsapp' and t.state = 'confirmed' and w.direction = 'inbound'
       and w.occurred_at > now() - interval '${AUTO_DEAL_UPDATE_DAYS} days'
       and not exists (select 1 from relay_job j join relay_item r on r.id = j.item_id
         where r.bulk_listing_id = t.bulk_listing_id and left(j.note, 6) = '${DEAL_NOTE}' and j.created_at >= w.occurred_at)
     order by t.bulk_listing_id, w.occurred_at desc`, [ownerId]);
}

/** Queues the update for each due chat through `start` (one job per email at a time, as for email replies). Off with
 * RELAY_AUTO_DEAL_UPDATE=off. Returns the deals queued. */
export async function queueWhatsAppUpdates(ownerId: string, start: (update: WhatsAppUpdate) => Promise<void>, env: Record<string, string | undefined> = process.env): Promise<string[]> {
  if (!autoDealUpdateOn(env)) return [];
  const queued: string[] = [];
  for (const update of (await whatsAppUpdatesDue(ownerId)).slice(0, 5)) {
    try { await start(update); queued.push(update.listing_id); } catch { /* busy or gone: the next pass looks again */ }
  }
  return queued;
}
