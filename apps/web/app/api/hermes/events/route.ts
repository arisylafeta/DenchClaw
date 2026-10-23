import { currentUser, sessionRevalidator } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { accessErrorResponse } from "@/lib/conversation-access";
import { authorizeConversation, getHermesChatService } from "@/lib/hermes-gateway/chat-service";
import { EventConnection, eventConnections } from "./registry";
import { validSubscriptionIds, validSubscriptionKeys } from "./subscription-limits";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) {return Response.json({ error: "Unauthorized" }, { status: 401 });}
  if (resolveAgentBackend() !== "hermes") {return Response.json({ error: "Hermes is not enabled" }, { status: 404 });}
  // Canonical keys contain encoded commas; decode the list only after splitting it.
  const keys = new URL(req.url).searchParams.get("keys")?.split(",").filter(Boolean) ?? [];
  if (!validSubscriptionKeys(keys)) {return Response.json({ error: "invalid_subscriptions" }, { status: 400 });}
  const revalidate = await sessionRevalidator();
  try { for (const key of keys) { authorizeConversation(key); await getHermesChatService().authorize(user,key); } } catch (error) {
    return accessErrorResponse(error);
  }
  const lastId = req.headers.get("Last-Event-ID");
  const match = lastId?.match(/^(\d+):(\d+)$/);
  if (lastId && !match) {return Response.json({ error: "invalid_cursor" }, { status: 400 });}
  const cursor = match && keys.length === 1 ? { generation: Number(match[1]), seq: Number(match[2]) } : undefined;
  let subscriptionIds: Record<string, string> = {};
  try {
    subscriptionIds = JSON.parse(new URL(req.url).searchParams.get("subscriptionIds") ?? "{}");
    if (!validSubscriptionIds(subscriptionIds)) {throw new Error();}
  } catch { return Response.json({ error: "invalid_subscription_ids" }, { status: 400 }); }
  let close = () => {};
  let pump: () => Promise<void> = async () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const pending: { bytes: Uint8Array; offset: number; snapshot: boolean; key?: string; version?: number }[] = [];
      let bufferedEvents = 0;
      // enqueue() can call pull() synchronously when a reader is already waiting. Without this
      // guard the nested pump re-sent the same slice (its header newline landed mid-JSON on 64 KiB+ snapshots).
      let pumping = false;
      pump = async () => {
        if (pumping) {return;}
        pumping = true;
        try {
          while (!closed && pending.length && (controller.desiredSize ?? 0) > 0) {
            const item = pending[0];
            if (item.key) {
              try {
                const actor = await revalidate();
                if (!actor || actor.id !== user.id) { close(); return; }
                const grant = await getHermesChatService().authorize(actor,item.key);
                if (grant.version !== item.version) {throw Error();}
              } catch {
                const partial = item.offset > 0;
                for (let i=pending.length-1;i>=0;i--) {if (pending[i].key === item.key) {pending.splice(i,1);}}
                bufferedEvents = pending.filter(row => !row.snapshot).reduce((sum,row) => sum+row.bytes.byteLength-row.offset,0);
                if (partial) { close(); return; }
                emit("access-revoked",{key:item.key});
                continue;
              }
              if (closed || pending[0] !== item) {continue;}
            }
            const start = item.offset;
            const size = Math.min(item.bytes.byteLength - start, controller.desiredSize ?? 0, 65_536);
            item.offset += size;
            if (!item.snapshot) {bufferedEvents -= size;}
            if (item.offset === item.bytes.byteLength) {pending.shift();}
            controller.enqueue(item.bytes.subarray(start, start + size));
          }
        } finally { pumping = false; }
      };
      const enqueue = (bytes: Uint8Array, snapshot = false, key?: string, version?: number) => {
        if (closed) {return;}
        // Snapshots are demand-paced, including an individual very large message.
        // Only live-event backlog counts as a slow reader.
        if (!snapshot && bufferedEvents + bytes.byteLength + 65_536 - (controller.desiredSize ?? 0) > 4_194_304) { close(); return; }
        if (!snapshot) {bufferedEvents += bytes.byteLength;}
        pending.push({ bytes, offset: 0, snapshot, key, version });
        void pump();
      };
      const emit = (event: string, payload: unknown, id?: string, version?: number) => {
        const key = payload && typeof payload === "object" && "key" in payload ? String(payload.key) : undefined;
        if (event === "access-revoked" && key) {
          if (pending.some(item => item.key === key && item.offset > 0)) { close(); return; }
          for (let i=pending.length-1;i>=0;i--) {if (pending[i].key === key) {pending.splice(i,1);}}
          bufferedEvents = pending.filter(row => !row.snapshot).reduce((sum,row) => sum+row.bytes.byteLength-row.offset,0);
        }
        enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`), event === "snapshot", event === "access-revoked" ? undefined : key, version);
      };
      const connection = new EventConnection(user, emit, getHermesChatService(), revalidate);
      eventConnections.set(connection.id, connection);
      const heartbeat = setInterval(() => enqueue(encoder.encode(": heartbeat\n\n")), 15_000);
      close = () => {
        if (closed) {return;}
        closed = true;
        clearInterval(heartbeat);
        connection.close(); eventConnections.delete(connection.id);
        req.signal.removeEventListener("abort", close);
        controller.close();
      };
      req.signal.addEventListener("abort", close, { once: true });
      emit("connection", { connectionId: connection.id });
      connection.emitGatewayState();
      void connection.update(keys, [], cursor, subscriptionIds).catch(error => { emit("error", { error: error instanceof Error ? error.message : "snapshot_failed" }); close(); });
      if (req.signal.aborted) {close();}
    },
    pull() { return pump(); },
    cancel() { close(); },
  }, { highWaterMark: 65_536, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
