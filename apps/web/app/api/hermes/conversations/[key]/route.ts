import { resolveAgentBackend } from "@/lib/agent-backend";
import { stopNativeHermesStream } from "@/lib/hermes-client";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { assertProfile, groupRpc, nativeFetch, readConversation } from "@/lib/hermes-native";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ key: string }> };
export async function PATCH(req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const key = (await context.params).key;
    const identity = parseConversationKey(key);
    if (identity.kind !== "solo") return Response.json({ error: "Use Hermes to manage group rooms" }, { status: 405 });
    const { title } = await req.json();
    if (typeof title !== "string" || !title.trim()) return Response.json({ error: "A title is required" }, { status: 400 });
    await nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}`, { method: "PATCH", body: JSON.stringify({ title }) });
    return Response.json(await readConversation(key));
  } catch { return Response.json({ error: "Could not rename native chat" }, { status: 502 }); }
}
export async function DELETE(_req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const identity = parseConversationKey((await context.params).key);
    if (identity.kind !== "solo") return Response.json({ error: "Use Hermes to manage group rooms" }, { status: 405 });
    const path = `/api/sessions/${encodeURIComponent(identity.id)}`;
    await nativeFetch(identity.profile, path, { method: "DELETE" });
    const verification = await nativeFetch(identity.profile, path, {}, [404]);
    if (verification.status !== 404) throw new Error("Deletion not verified");
    return Response.json({ deleted: identity.id });
  } catch { return Response.json({ error: "Could not delete native chat" }, { status: 502 }); }
}
export async function GET(req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get("since_seq") ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) return Response.json({ error: "Invalid replay cursor" }, { status: 400 });
  try { return Response.json(await readConversation((await context.params).key, since)); }
  catch { return Response.json({ error: "Could not load Hermes conversation" }, { status: 502 }); }
}
export async function POST(req: Request, context: Context) {
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const { key } = await context.params;
    const identity = parseConversationKey(key);
    const body = await req.json();
    if (identity.kind === "solo") {
      assertProfile(identity.profile);
      if (body.action !== "stop") return Response.json({ error: "Solo chats use /api/chat" }, { status: 405 });
      return Response.json({ aborted: stopNativeHermesStream(identity.profile, identity.id) });
    }
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
    return Response.json({ error: "Unsupported conversation action" }, { status: 400 });
  } catch {
    return Response.json({ error: "Hermes request failed. Refresh the conversation before retrying." }, { status: 502 });
  }
}
