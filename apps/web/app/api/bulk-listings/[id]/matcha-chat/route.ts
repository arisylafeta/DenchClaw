import { currentUser } from "@/lib/auth";
import { accessErrorResponse } from "@/lib/conversation-access";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { createConversation, readConversation } from "@/lib/hermes-native";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { createGatewayConversation } from "@/lib/hermes-gateway/chat-service";
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
      // A deleted or withdrawn chat falls through to a fresh one.
      const existing = await readConversation(saved, 0, undefined, actor).then((r) => r.conversation).catch(() => null);
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
