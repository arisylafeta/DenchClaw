import { ConversationAccessError, accessErrorResponse } from "@/lib/conversation-access";
import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeConversation, ChatServiceError, getHermesChatService, parseGatewayPrompt } from "@/lib/hermes-gateway/chat-service";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
export type GatewayRouteContext = { params: Promise<{ key: string }> };
export async function gatewayCommand(req: Request, context: GatewayRouteContext, action: string) {
  const actor = await currentUser();
  if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const { key } = await context.params;
    authorizeConversation(key);
    if (["prompt", "steer", "interrupt", "model", "reasoning", "fast", "slash-complete", "slash-execute", "control"].includes(action) && hermesChatTransport() !== "gateway") return Response.json({ error: "sse_transport" }, { status: 409 });
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatServiceError(400, "invalid_body");
    const service = getHermesChatService();
    const result = action === "prompt" ? await service.sendPrompt(key, parseGatewayPrompt(body),actor)
      : action === "branch" ? { conversation: await service.branchConversation(key,actor) }
      : action === "slash-complete" ? await service.slashComplete(key, body,actor)
      : action === "slash-execute" ? await service.slashExecute(key, body,actor)
      : await service.command(key, action, body,actor);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ConversationAccessError) return accessErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : "gateway_failed" }, { status: error instanceof ChatServiceError ? error.status : error instanceof SyntaxError ? 400 : 502 });
  }
}
