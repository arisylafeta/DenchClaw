import { messageTextHash } from "../hermes-chat/html-map";
export { messageTextHash } from "../hermes-chat/html-map";
import { queryPg } from "../postgres";

export interface MessageHtmlRecord {
  client_message_id: string;
  text_hash: string;
  html: string;
  created_at: string;
}
export async function saveMessageHtml(profile: string, storedSessionId: string, clientMessageId: string, text: string, html: string): Promise<void> {
  await queryPg(`insert into hermes_message_html (profile, stored_session_id, client_message_id, text_hash, html)
    values ($1, $2, $3, $4, $5) on conflict (profile, stored_session_id, client_message_id)
    do update set text_hash = excluded.text_hash, html = excluded.html`,
  [profile, storedSessionId, clientMessageId, messageTextHash(text), html]);
}
export async function lookupMessageHtml(profile: string, storedSessionId: string): Promise<MessageHtmlRecord[]> {
  return queryPg<MessageHtmlRecord>(`select client_message_id, text_hash, html, created_at::text from hermes_message_html
    where profile = $1 and stored_session_id = $2 order by created_at, client_message_id`, [profile, storedSessionId]);
}
