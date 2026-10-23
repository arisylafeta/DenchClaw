import { ConversationAccessError, accessErrorResponse } from "@/lib/conversation-access";
import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeConversation, ChatServiceError, getHermesChatService } from "@/lib/hermes-gateway/chat-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  const actor = await currentUser();
  if (!actor) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  if (resolveAgentBackend() !== "hermes") {return Response.json({ error: "Hermes is not enabled" }, { status: 404 });}
  try {
    const { key } = await context.params;
    authorizeConversation(key);
    const query = new URL(req.url).searchParams;
    return Response.json(await getHermesChatService().historyPage(key, query.get("before") ?? "", Number(query.get("limit") ?? 200),actor));
  } catch (error) {
    if (error instanceof ConversationAccessError) {return accessErrorResponse(error);}
    return Response.json({ error: error instanceof Error ? error.message : "history_failed" }, { status: error instanceof ChatServiceError ? error.status : 502 });
  }
}
