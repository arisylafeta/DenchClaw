import { currentUser } from "@/lib/auth";
import { accessErrorResponse, tombstoneConversation, assertSafePrompt } from "@/lib/conversation-access";
import { authorizeNativeConversation } from "@/lib/hermes-native";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { stopNativeHermesStream } from "@/lib/hermes-client";
import { parseConversationKey } from "@/lib/hermes-conversations";
import { assertProfile, groupRpc, nativeFetch, readConversation } from "@/lib/hermes-native";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ key: string }> };
export async function PATCH(req: Request, context: Context) {
  const actor = await currentUser(); if (!actor) return Response.json({error:"Unauthorized"},{status:401});
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const key = (await context.params).key;
    await authorizeNativeConversation(actor,key,req.method === "GET" ? "read" : "write");
    const identity = parseConversationKey(key);
    const { title } = await req.json();
    if (typeof title !== "string" || !title.trim() || title.length > 200) return Response.json({ error: "A title of at most 200 characters is required" }, { status: 400 });
    if (identity.kind === "group") await groupRpc("groups.rename", { room_id: identity.id, event_id: crypto.randomUUID(), name: title.trim() });
    else await nativeFetch(identity.profile, `/api/sessions/${encodeURIComponent(identity.id)}`, { method: "PATCH", body: JSON.stringify({ title: title.trim() }) });
    return Response.json(await readConversation(key,0,undefined,actor));
  } catch (error) { return accessErrorResponse(error); }
}
export async function DELETE(_req: Request, context: Context) {
  const actor = await currentUser(); if (!actor) return Response.json({error:"Unauthorized"},{status:401});
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const key = (await context.params).key;
    await authorizeNativeConversation(actor,key,"delete");
    const identity = parseConversationKey(key);
    await tombstoneConversation(actor,key);
    if (identity.kind === "group") {
      await groupRpc("groups.disband", {room_id:identity.id});
      let offset: number | null = 0;
      while (offset !== null) {
        const page: {rooms:{room_id:string}[];next_offset:number|null} = await groupRpc("groups.list",{limit:100,offset});
        if (page.rooms.some(room => room.room_id === identity.id)) throw new Error("Deletion not verified");
        if (page.next_offset !== null && page.next_offset <= offset) throw new Error("Invalid room pagination");
        offset=page.next_offset;
      }
      return Response.json({deleted:identity.id});
    }
    const path = `/api/sessions/${encodeURIComponent(identity.id)}`;
    await nativeFetch(identity.profile, path, { method: "DELETE" });
    const verification = await nativeFetch(identity.profile, path, {}, [404]);
    if (verification.status !== 404) throw new Error("Deletion not verified");
    return Response.json({ deleted: identity.id });
  } catch (error) { return accessErrorResponse(error); }
}
export async function GET(req: Request, context: Context) {
  const actor = await currentUser(); if (!actor) return Response.json({error:"Unauthorized"},{status:401});
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  const since = Number(new URL(req.url).searchParams.get("since_seq") ?? 0);
  if (!Number.isSafeInteger(since) || since < 0) return Response.json({ error: "Invalid replay cursor" }, { status: 400 });
  try { const key = (await context.params).key; await authorizeNativeConversation(actor,key); return Response.json(await readConversation(key, since,undefined,actor)); }
  catch (error) { return accessErrorResponse(error); }
}
export async function POST(req: Request, context: Context) {
  const actor = await currentUser(); if (!actor) return Response.json({error:"Unauthorized"},{status:401});
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  try {
    const { key } = await context.params;
    await authorizeNativeConversation(actor,key,req.method === "GET" ? "read" : "write");
    const identity = parseConversationKey(key);
    const body = await req.json();
    if (identity.kind === "solo") {
      assertProfile(identity.profile);
      if (hermesChatTransport() === "gateway" && body.action !== "stop") return Response.json({ error: "gateway_transport" }, { status: 409 });
      if (body.action !== "stop") return Response.json({ error: "Solo chats use /api/chat" }, { status: 405 });
      return Response.json({ aborted: stopNativeHermesStream(identity.profile, identity.id) });
    }
    if (identity.kind === "group" && body.action === "stop") {
      await groupRpc("groups.stop", { room_id: identity.id, cancel_id: body.eventId || "denchclaw-stop" });
      return Response.json(await readConversation(key,0,undefined,actor));
    }
    if (typeof body.message !== "string" || !body.message.trim() || Buffer.byteLength(body.message, "utf8") > 65_536) {
      return Response.json({ error: "A message of at most 64 KiB of UTF-8 text is required" }, { status: 400 });
    }
    if (identity.kind === "group") {
      assertSafePrompt(actor,{text:body.message});
      if (typeof body.eventId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.eventId)) return Response.json({ error: "A stable event ID is required" }, { status: 400 });
      await groupRpc("groups.send", { room_id: identity.id, event_id: body.eventId, payload: { text: body.message, thread_id: identity.id } });
      // Read the native log back before acknowledging persistence to the UI.
      return Response.json(await readConversation(key,0,undefined,actor));
    }
    return Response.json({ error: "Unsupported conversation action" }, { status: 400 });
  } catch (error) {
    return accessErrorResponse(error);
  }
}
