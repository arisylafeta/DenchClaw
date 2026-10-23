import { ALLOWED_EMAILS, type AuthenticatedUser } from "./auth";
import { conversationKey, parseConversationKey } from "./hermes-conversations";
import { queryPg } from "./postgres";

export type ConversationActor = AuthenticatedUser;
export type ConversationAccess = { visibility: "private" | "team"; ownerId: string | null; canShare: boolean; canDelete: boolean; canWrite: boolean; canApprove: boolean };
export type AccessAction = "read" | "write" | "share" | "delete" | "derive" | "approve";
export class ConversationAccessError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export const externalSources = new Set(["discord", "whatsapp", "cli", "tui", "telegram", "slack", "signal", "matrix", "mattermost", "sms", "email", "cron", "webhook"]);
type AccessRow = { owner_id: string | null; creator_id: string | null; origin: string; visibility: "private" | "team"; version: number; deleted_at: string | null };
export function canonicalIdentity(key: string) {
  try {
    const identity = parseConversationKey(key);
    if ((identity.kind === "group" && identity.profile !== "") || conversationKey(identity.kind, identity.id, identity.profile) !== key) throw Error();
    return identity;
  } catch { throw new ConversationAccessError(404, "not_found"); }
}
export function requireActor(actor?: ConversationActor): ConversationActor {
  if (!actor?.id) throw new ConversationAccessError(401, "Unauthorized");
  return actor;
}
export function accessFor(row: AccessRow, actor: ConversationActor, action: AccessAction = "read"): ConversationAccess {
  const owner = row.owner_id === actor.id;
  if (row.deleted_at || (!owner && row.visibility !== "team") || (["share", "delete", "derive"].includes(action) && !owner) || (action === "approve" && !ALLOWED_EMAILS.has(actor.email))) throw new ConversationAccessError(404, "not_found");
  const writable = !["cron", "webhook"].includes(row.origin);
  if (action === "write" && !writable) throw new ConversationAccessError(409, "automation_read_only");
  return { visibility: row.visibility, ownerId: row.owner_id, canShare: owner, canDelete: owner, canWrite: writable, canApprove: ALLOWED_EMAILS.has(actor.email) };
}
async function db<T extends Record<string, unknown>>(sql: string, params: readonly unknown[]) {
  try { return await queryPg<T>(sql, params); }
  catch { throw new ConversationAccessError(503, "conversation_access_unavailable"); }
}
export async function authorizeAccess(actor: ConversationActor | undefined, key: string, action: AccessAction = "read", source?: () => Promise<string | undefined>) {
  const user = requireActor(actor); const identity = canonicalIdentity(key);
  const params = [identity.kind, identity.profile, identity.id];
  let rows = await db<AccessRow>("select owner_id, creator_id, origin, visibility, version, deleted_at from hermes_security.conversation_access where kind=$1 and profile=$2 and stored_id=$3", params);
  if (!rows.length && identity.kind === "solo" && source) {
    const origin = await source();
    if (origin && externalSources.has(origin)) {
      await db("insert into hermes_security.conversation_access(kind,profile,stored_id,origin,visibility) values($1,$2,$3,$4,'team') on conflict do nothing", [...params, origin]);
      rows = await db<AccessRow>("select owner_id, creator_id, origin, visibility, version, deleted_at from hermes_security.conversation_access where kind=$1 and profile=$2 and stored_id=$3", params);
    }
  }
  if (!rows[0]) throw new ConversationAccessError(404, "not_found");
  return { access: accessFor(rows[0], user, action), version: Number(rows[0].version) };
}
export async function registerConversation(actor: ConversationActor | undefined, key: string, inherited?: ConversationAccess) {
  const user = requireActor(actor); const id = canonicalIdentity(key);
  if (inherited && inherited.ownerId !== user.id) throw new ConversationAccessError(404, "not_found");
  const rows = await db<AccessRow>(`insert into hermes_security.conversation_access(kind,profile,stored_id,creator_id,owner_id,origin,visibility) values($1,$2,$3,$4,$4,'crm',$5) returning owner_id,creator_id,origin,visibility,version,deleted_at`, [id.kind,id.profile,id.id,user.id,inherited?.visibility ?? "private"]);
  return accessFor(rows[0],user);
}
export async function changeSharing(actor: ConversationActor | undefined, key: string, visibility: "private" | "team") {
  const user = requireActor(actor); const id = canonicalIdentity(key);
  await authorizeAccess(user,key,"share");
  const rows = await db<AccessRow>(`update hermes_security.conversation_access set visibility=$5, version=version+1 where kind=$1 and profile=$2 and stored_id=$3 and owner_id=$4 and deleted_at is null returning owner_id,creator_id,origin,visibility,version,deleted_at`,[id.kind,id.profile,id.id,user.id,visibility]);
  if (!rows[0]) throw new ConversationAccessError(404,"not_found");
  return accessFor(rows[0],user);
}
export async function tombstoneConversation(actor: ConversationActor | undefined, key: string) {
  const user = requireActor(actor); const id = canonicalIdentity(key);
  await authorizeAccess(user,key,"delete");
  const rows = await db(`update hermes_security.conversation_access set deleted_at=now(), version=version+1 where kind=$1 and profile=$2 and stored_id=$3 and owner_id=$4 and deleted_at is null returning stored_id`,[id.kind,id.profile,id.id,user.id]);
  if (!rows.length) throw new ConversationAccessError(404,"not_found");
}
/** Non-admin prompts cannot trigger host attachment hydration or workspace-context reads. Agent tools remain a separate trust boundary. */
export function assertSafePrompt(actor: ConversationActor | undefined, prompt: { text: string; context?: unknown }) {
  const user = requireActor(actor);
  if (!ALLOWED_EMAILS.has(user.email) && (prompt.context || /\[Attached files:|(?:\[\[(?:image|file)|\[image:|!\[[^\]]*\]\((?:file:|\/)|(?:^|\s)(?:file:\/\/|\/root\/|\/srv\/|\/etc\/))/i.test(prompt.text))) throw new ConversationAccessError(403,"host_attachments_unavailable");
}
export function accessErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof ConversationAccessError ? error.message : "hermes_request_failed" }, { status: error instanceof ConversationAccessError ? error.status : 502 });
}
