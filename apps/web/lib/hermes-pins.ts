import { requireActor, ConversationAccessError, type ConversationActor } from "./conversation-access";
import { authorizeNativeConversation } from "./hermes-native";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { assertProfile, groupRpc, nativeFetch } from "@/lib/hermes-native";
import { queryPg } from "@/lib/postgres";

/** Per-user CRM sidebar pins. Independent of Hermes's sessions.pinned archival keep flag. */
export class PinError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export async function listPins(userId: string, actor?: ConversationActor): Promise<string[]> {
  if (requireActor(actor).id !== userId) throw new ConversationAccessError(404,"not_found");
  const rows = await queryPg<{ conversation_key: string }>(
    "select conversation_key from crm_user_chat_pins where user_id = $1 order by pinned_at, conversation_key", [userId]);
  const keys: string[] = [];
  for (const row of rows) {
    try { await authorizeNativeConversation(actor,row.conversation_key); keys.push(row.conversation_key); }
    catch(error) { if (!(error instanceof ConversationAccessError) || error.status !== 404) throw error; }
  }
  return keys;
}

/** Exact target resolution: the key must parse and the chat must exist. Only used when pinning, so stale pins can still be removed. */
export async function assertPinnable(key: string): Promise<void> {
  let identity;
  try { identity = parseConversationKey(key); } catch { throw new PinError(400, "invalid_conversation_key"); }
  if (identity.kind === "solo") {
    try { assertProfile(identity.profile); } catch { throw new PinError(404, "unknown_profile"); }
    let response;
    try { response = await nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}`, {}, [404]); }
    catch { throw new PinError(502, "target_lookup_failed"); }
    if (response.status === 404) throw new PinError(404, "chat_not_found");
    return;
  }
  try { await groupRpc("groups.state", { room_id: identity.id }); }
  catch { throw new PinError(404, "chat_not_found"); }
}

/** Idempotent. Returns the caller's pins re-read from the database, and fails if the write is not visible there. */
export async function setPin(userId: string, key: string, pinned: boolean, actor?: ConversationActor): Promise<string[]> {
  if (requireActor(actor).id !== userId) throw new ConversationAccessError(404,"not_found");
  if (pinned) {
    await authorizeNativeConversation(actor,key);
    await assertPinnable(key);
    await queryPg("insert into crm_user_chat_pins (user_id, conversation_key) values ($1, $2) on conflict do nothing", [userId, key]);
  } else {
    await queryPg("delete from crm_user_chat_pins where user_id = $1 and conversation_key = $2", [userId, key]);
  }
  const pins = await listPins(userId,actor);
  if (pins.includes(key) !== pinned) throw new PinError(500, "pin_not_persisted");
  return pins;
}
