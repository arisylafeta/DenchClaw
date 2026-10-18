import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeConversation, ChatServiceError, getHermesChatService } from "@/lib/hermes-gateway/chat-service";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import type { GatewayRouteContext } from "../gateway-command";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, context: GatewayRouteContext) {
  if (!await currentUser()) { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (resolveAgentBackend() !== "hermes") { return Response.json({ error: "Hermes is not enabled" }, { status: 404 }); }
  try {
    const { key } = await context.params;
    authorizeConversation(key);
    if (hermesChatTransport() !== "gateway") { return Response.json({ error: "sse_transport" }, { status: 409 }); }
    return Response.json(await getHermesChatService().modelOptions(key));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "model_options_failed" }, { status: error instanceof ChatServiceError ? error.status : 502 });
  }
}
