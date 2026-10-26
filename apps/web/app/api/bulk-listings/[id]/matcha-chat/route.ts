import { currentUser } from "@/lib/auth";
import { accessErrorResponse, changeSharing } from "@/lib/conversation-access";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeNativeConversation, createConversation, readConversation } from "@/lib/hermes-native";
import { parseConversationKey, type HermesConversation } from "@/lib/hermes-conversations";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { createGatewayConversation, pendingGatewayConversation } from "@/lib/hermes-gateway/chat-service";
import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { listingChatPins, saveListingChat } from "@/lib/crm-postgres/bulk-listing-chats";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const PROFILE = "matcha";

/** Makes a chat started from a listing team-visible, so the whole team lands in the same conversation. */
const share = (actor: NonNullable<Awaited<ReturnType<typeof currentUser>>>, key: string) => changeSharing(actor, key, "team");

/**
 * The listing's Matcha chat, shared by default: the newest team-visible chat pinned to this listing by anyone the
 * signed-in user can open, else their own older private pin, else a new team-shared chat that is then pinned.
 */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  const actor = await currentUser();
  if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const transport = hermesChatTransport();
  try {
    const opened: { conversation: HermesConversation; team: boolean }[] = [];
    for (const pin of await listingChatPins(id)) {
      // A deleted, withdrawn or private-to-someone-else chat is skipped.
      const access = await authorizeNativeConversation(actor, pin.key).then((r) => r.access).catch(() => null);
      if (!access) continue;
      // A chat nobody has written in yet only exists in this process, so it is reopened from there.
      const pending = transport === "gateway" ? pendingGatewayConversation(pin.key) : undefined;
      const conversation = pending ? { ...pending, access }
        : await readConversation(pin.key, 0, undefined, actor).then((r) => r.conversation).catch(() => null);
      if (conversation) opened.push({ conversation, team: access.visibility === "team" });
    }
    const existing = opened.find((c) => c.team) ?? opened[0];
    if (existing) return Response.json({ conversation: existing.conversation, transport });
    const created = transport === "gateway"
      ? await createGatewayConversation([PROFILE], actor)
      : await createConversation([PROFILE], undefined, actor);
    const conversation = Object.assign(created, { access: await share(actor, created.key) });
    await saveListingChat(id, actor.id, conversation.key);
    return Response.json({ conversation, transport }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

/** Re-pins the listing to another Matcha conversation (after /new or a branch inside the tab). */
export async function PUT(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  const actor = await currentUser();
  if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const key = (await req.json().catch(() => null) as { key?: unknown } | null)?.key;
  if (typeof key !== "string") return Response.json({ error: "key required" }, { status: 400 });
  try {
    const identity = parseConversationKey(key);
    if (identity.kind !== "solo" || identity.profile !== PROFILE) return Response.json({ error: "Not a Matcha chat" }, { status: 400 });
    const { access } = await authorizeNativeConversation(actor, key, "write");
    // A chat started with /new belongs to its starter; shared by default like the first one. Someone else's chat keeps its setting.
    if (access.canShare && access.visibility !== "team") await share(actor, key);
    await saveListingChat(id, actor.id, key);
    return Response.json({ ok: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
