import { currentUser } from "@/lib/auth";
import { accessErrorResponse } from "@/lib/conversation-access";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { createConversation, listConversations } from "@/lib/hermes-native";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { createGatewayConversation } from "@/lib/hermes-gateway/chat-service";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  const actor = await currentUser(); if (!actor) {return Response.json({error:"Unauthorized"},{status:401});}
  if (resolveAgentBackend() !== "hermes") {return Response.json({ backend: "openclaw" });}
  try { return Response.json({ ...await listConversations(actor), userId:actor.id, transport: hermesChatTransport() }); }
  catch (error) { return accessErrorResponse(error); }
}
export async function POST(req: Request) {
  const actor = await currentUser(); if (!actor) {return Response.json({error:"Unauthorized"},{status:401});}
  if (resolveAgentBackend() !== "hermes") {return Response.json({ error: "Hermes is not enabled" }, { status: 404 });}
  try {
    const body = await req.json();
    const conversation = hermesChatTransport() === "gateway" && Array.isArray(body.profiles) && body.profiles.length === 1
      ? await createGatewayConversation(body.profiles,actor)
      : await createConversation(body.profiles, typeof body.title === "string" ? body.title : undefined,actor);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
