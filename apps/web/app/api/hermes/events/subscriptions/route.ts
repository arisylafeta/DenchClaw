import { ConversationAccessError, accessErrorResponse } from "@/lib/conversation-access";
import { currentUser } from "@/lib/auth";
import { authorizeConversation, ChatServiceError } from "@/lib/hermes-gateway/chat-service";
import { eventConnections } from "../registry";
import { validSubscriptionIds, validSubscriptionKeys } from "../subscription-limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (typeof body.connectionId !== "string" || body.connectionId.length > 256 || !validSubscriptionKeys(body.add) || !validSubscriptionKeys(body.remove)) return Response.json({ error: "invalid_subscriptions" }, { status: 400 });
    if (body.subscriptionIds !== undefined && !validSubscriptionIds(body.subscriptionIds)) return Response.json({ error: "invalid_subscription_ids" }, { status: 400 });
    const connection = eventConnections.get(body.connectionId);
    if (!connection || connection.userId !== user.id) return Response.json({ error: "connection_not_owned" }, { status: 403 });
    [...body.add, ...body.remove].forEach(authorizeConversation);
    await connection.update(body.add, body.remove, undefined, body.subscriptionIds);
    return Response.json({ subscribed: true });
  } catch (error) {
    if (error instanceof ConversationAccessError) return accessErrorResponse(error);
    return Response.json({ error: error instanceof Error ? error.message : "subscription_failed" }, { status: error instanceof ChatServiceError ? error.status : error instanceof SyntaxError ? 400 : 502 });
  }
}
