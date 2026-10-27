import { accessErrorResponse } from "@/lib/conversation-access";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeNativeConversation, createConversation, readConversation } from "@/lib/hermes-native";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { createGatewayConversation, pendingGatewayConversation } from "@/lib/hermes-gateway/chat-service";
import { guardRelay } from "@/lib/relay-route";
import { readRelayItem, relayChatKey, saveRelayChat } from "@/lib/relay";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
const PROFILE = "mailvin";

/** The agent conversation pinned to this email, private to Alex: reopened if it still exists, else a new one. */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  const { id } = await params;
  const actor = guard.user;
  if (!await readRelayItem(id, actor.id)) return Response.json({ error: "Not found" }, { status: 404 });
  const transport = hermesChatTransport();
  try {
    const key = await relayChatKey(id, actor.id);
    if (key) {
      const access = await authorizeNativeConversation(actor, key).then((r) => r.access).catch(() => null);
      if (access) {
        const pending = transport === "gateway" ? pendingGatewayConversation(key) : undefined;
        const conversation = pending ? { ...pending, access }
          : await readConversation(key, 0, undefined, actor).then((r) => r.conversation).catch(() => null);
        if (conversation) return Response.json({ conversation, transport });
      }
    }
    const conversation = transport === "gateway" ? await createGatewayConversation([PROFILE], actor) : await createConversation([PROFILE], undefined, actor);
    await saveRelayChat(id, actor.id, conversation.key);
    return Response.json({ conversation, transport }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}

/** Re-pins the email to another conversation (after /new or a branch). */
export async function PUT(req: Request, { params }: Context) {
  const guard = await guardRelay();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await readRelayItem(id, guard.user.id)) return Response.json({ error: "Not found" }, { status: 404 });
  const key = (await req.json().catch(() => null) as { key?: unknown } | null)?.key;
  if (typeof key !== "string") return Response.json({ error: "key required" }, { status: 400 });
  try {
    const identity = parseConversationKey(key);
    if (identity.kind !== "solo" || identity.profile !== PROFILE) return Response.json({ error: "Not a Relay chat" }, { status: 400 });
    await authorizeNativeConversation(guard.user, key, "write");
    await saveRelayChat(id, guard.user.id, key);
    return Response.json({ ok: true });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
