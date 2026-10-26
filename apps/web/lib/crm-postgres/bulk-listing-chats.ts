import { queryPg } from "../postgres";

/** Every conversation pinned to a listing by any user, newest pin first. Access is checked by the caller. */
export async function listingChatPins(listingId: string): Promise<{ key: string; userId: string }[]> {
  const rows = await queryPg<{ conversation_key: string; user_id: string }>(
    "select conversation_key, user_id from crm_bulk_listing_chats where listing_id = $1 order by created_at desc", [listingId]);
  return rows.map((r) => ({ key: r.conversation_key, userId: r.user_id }));
}

/** Pins the conversation to the listing for this user; the latest pin is the one everyone is sent to. */
export async function saveListingChat(listingId: string, userId: string, key: string): Promise<void> {
  await queryPg(
    `insert into crm_bulk_listing_chats (listing_id, user_id, conversation_key) values ($1, $2::uuid, $3)
     on conflict (listing_id, user_id) do update set conversation_key = excluded.conversation_key, created_at = now()`, [listingId, userId, key]);
}
