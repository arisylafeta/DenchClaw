import { currentUser } from "@/lib/auth";
import { accessErrorResponse } from "@/lib/conversation-access";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeNativeConversation, createConversation, readConversation } from "@/lib/hermes-native";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { createGatewayConversation, pendingGatewayConversation } from "@/lib/hermes-gateway/chat-service";
import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { savedListingChat, saveListingChat } from "@/lib/crm-postgres/bulk-listing-chats";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const PROFILE = "matcha";

/** Opens the signed-in user's Matcha chat for this listing: the saved conversation, or a new one that is then remembered. */
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
    const saved = await savedListingChat(id, actor.id);
    if (saved) {
      // A chat nobody has written in yet only exists in this process, so it is reopened from there. A deleted or
      // withdrawn chat falls through to a fresh one.
      const existing = transport === "gateway" && pendingGatewayConversation(saved)
        || await readConversation(saved, 0, undefined, actor).then((r) => r.conversation).catch(() => null);
      if (existing) return Response.json({ conversation: existing, transport });
    }
    const conversation = transport === "gateway"
      ? await createGatewayConversation([PROFILE], actor)
      : await createConversation([PROFILE], undefined, actor);
    await saveListingChat(id, actor.id, conversation.key);
    return Response.json({ conversation, transport }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

/** Re-pins the listing to another Matcha conversation of the signed-in user (after /new or a branch inside the tab). */
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
    await authorizeNativeConversation(actor, key, "write");
    await saveListingChat(id, actor.id, key);
    return Response.json({ ok: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
