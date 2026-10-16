import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { authorizeConversation, ChatServiceError } from "@/lib/hermes-gateway/chat-service";
import { EventConnection, eventConnections } from "./registry";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (resolveAgentBackend() !== "hermes") return Response.json({ error: "Hermes is not enabled" }, { status: 404 });
  // Canonical keys contain encoded commas; decode the list only after splitting it.
  const keys = new URL(req.url).searchParams.get("keys")?.split(",").filter(Boolean) ?? [];
  try { keys.forEach(authorizeConversation); } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "invalid_key" }, { status: error instanceof ChatServiceError ? error.status : 400 });
  }
  const lastId = req.headers.get("Last-Event-ID");
  const match = lastId?.match(/^(\d+):(\d+)$/);
  if (lastId && !match) return Response.json({ error: "invalid_cursor" }, { status: 400 });
  const cursor = match && keys.length === 1 ? { generation: Number(match[1]), seq: Number(match[2]) } : undefined;
  let subscriptionIds: Record<string, string> = {};
  try {
    subscriptionIds = JSON.parse(new URL(req.url).searchParams.get("subscriptionIds") ?? "{}");
    if (!subscriptionIds || Array.isArray(subscriptionIds) || typeof subscriptionIds !== "object" || !Object.values(subscriptionIds).every(id => typeof id === "string")) throw new Error();
  } catch { return Response.json({ error: "invalid_subscription_ids" }, { status: 400 }); }
  let close = () => {};
  let pump = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const pending: { bytes: Uint8Array; offset: number; snapshot: boolean }[] = [];
      let bufferedEvents = 0;
      pump = () => {
        while (!closed && pending.length && (controller.desiredSize ?? 0) > 0) {
          const item = pending[0];
          const size = Math.min(item.bytes.byteLength - item.offset, controller.desiredSize ?? 0, 65_536);
          controller.enqueue(item.bytes.subarray(item.offset, item.offset + size));
          item.offset += size;
          if (!item.snapshot) bufferedEvents -= size;
          if (item.offset === item.bytes.byteLength) pending.shift();
        }
      };
      const enqueue = (bytes: Uint8Array, snapshot = false) => {
        if (closed) return;
        // Snapshots are demand-paced, including an individual very large message.
        // Only live-event backlog counts as a slow reader.
        if (!snapshot && bufferedEvents + bytes.byteLength + 65_536 - (controller.desiredSize ?? 0) > 4_194_304) { close(); return; }
        if (!snapshot) bufferedEvents += bytes.byteLength;
        pending.push({ bytes, offset: 0, snapshot });
        pump();
      };
      const emit = (event: string, payload: unknown, id?: string) => {
        enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`), event === "snapshot");
      };
      const connection = new EventConnection(user.id, emit);
      eventConnections.set(connection.id, connection);
      const heartbeat = setInterval(() => enqueue(encoder.encode(": heartbeat\n\n")), 15_000);
      close = () => {
        if (closed) return;
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
      if (req.signal.aborted) close();
    },
    pull() { pump(); },
    cancel() { close(); },
  }, { highWaterMark: 65_536, size: chunk => chunk.byteLength });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
