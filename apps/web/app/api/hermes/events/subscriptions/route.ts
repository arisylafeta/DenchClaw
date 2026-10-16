import { currentUser } from "@/lib/auth";
import { authorizeConversation, ChatServiceError } from "@/lib/hermes-gateway/chat-service";
import { eventConnections } from "../registry";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await req.json();
    if (typeof body.connectionId !== "string" || !Array.isArray(body.add) || !Array.isArray(body.remove) || ![...body.add, ...body.remove].every(key => typeof key === "string")) return Response.json({ error: "invalid_subscriptions" }, { status: 400 });
    if (body.subscriptionIds !== undefined && (!body.subscriptionIds || typeof body.subscriptionIds !== "object" || Array.isArray(body.subscriptionIds) || !Object.values(body.subscriptionIds).every(id => typeof id === "string"))) return Response.json({ error: "invalid_subscription_ids" }, { status: 400 });
    const connection = eventConnections.get(body.connectionId);
    if (!connection || connection.userId !== user.id) return Response.json({ error: "connection_not_owned" }, { status: 403 });
    [...body.add, ...body.remove].forEach(authorizeConversation);
    await connection.update(body.add, body.remove, undefined, body.subscriptionIds);
    return Response.json({ subscribed: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "subscription_failed" }, { status: error instanceof ChatServiceError ? error.status : error instanceof SyntaxError ? 400 : 502 });
  }
}
