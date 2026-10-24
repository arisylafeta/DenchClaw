import { queryPg } from "../postgres";

/** The signed-in user's saved Matcha conversation for a listing, if any. */
export async function savedListingChat(listingId: string, userId: string): Promise<string | null> {
  const rows = await queryPg<{ conversation_key: string }>(
    "select conversation_key from crm_bulk_listing_chats where listing_id = $1 and user_id = $2::uuid", [listingId, userId]);
  return rows[0]?.conversation_key ?? null;
}

/** Remembers the conversation for this listing and user, replacing a stale one. */
export async function saveListingChat(listingId: string, userId: string, key: string): Promise<void> {
  await queryPg(
    `insert into crm_bulk_listing_chats (listing_id, user_id, conversation_key) values ($1, $2::uuid, $3)
     on conflict (listing_id, user_id) do update set conversation_key = excluded.conversation_key`, [listingId, userId, key]);
}
