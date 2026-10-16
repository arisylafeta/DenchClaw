import { resolveAgentBackend } from "@/lib/agent-backend";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { groupRpc, nativeFetch, readConversation } from "@/lib/hermes-native";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ key: string }> };
export async function GET(_req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try { return Response.json(await readConversation((await context.params).key)); }
  catch { return Response.json({ error: "Could not load Hermes conversation" }, { status: 502 }); }
}
export async function POST(req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const { key } = await context.params;
    const identity = parseConversationKey(key);
    const body = await req.json();
    if (identity.kind === "group" && body.action === "stop") {
      await groupRpc("groups.stop", { room_id: identity.id, cancel_id: body.eventId || "denchclaw-stop" });
      return Response.json(await readConversation(key));
    }
    if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 100_000) {
      return Response.json({ error: "A message of at most 100000 characters is required" }, { status: 400 });
    }
    if (identity.kind === "group") {
      if (typeof body.eventId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.eventId)) return Response.json({ error: "A stable event ID is required" }, { status: 400 });
      await groupRpc("groups.send", { room_id: identity.id, event_id: body.eventId, payload: { text: body.message, thread_id: identity.id } });
      // Read the native log back before acknowledging persistence to the UI.
      return Response.json(await readConversation(key));
    }
    const response = await nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}/chat/stream`, {
      method: "POST", body: JSON.stringify({ message: body.message }), signal: req.signal,
    });
    return new Response(response.body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
  } catch {
    return Response.json({ error: "Hermes request failed. Refresh the conversation before retrying." }, { status: 502 });
  }
}
