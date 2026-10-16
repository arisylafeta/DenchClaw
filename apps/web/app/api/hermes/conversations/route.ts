import { resolveAgentBackend } from "@/lib/agent-backend";
import { createConversation, listConversations } from "@/lib/hermes-native";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  if (resolveAgentBackend() !== "hermes") return Response.json({ backend: "openclaw" });
  try { return Response.json(await listConversations()); }
  catch { return Response.json({ error: "Could not load Hermes conversations" }, { status: 502 }); }
}
export async function POST(req: Request) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const body = await req.json();
    const conversation = await createConversation(body.profiles, typeof body.title === "string" ? body.title : undefined);
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not create chat" }, { status: 400 });
  }
}
