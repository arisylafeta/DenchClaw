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
  let close = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const emit = (event: string, payload: unknown, id?: string) => {
        if (!closed) controller.enqueue(encoder.encode(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      const connection = new EventConnection(user.id, emit);
      eventConnections.set(connection.id, connection);
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": heartbeat\n\n")); }, 15_000);
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
      void connection.update(keys, [], cursor).catch(error => { emit("error", { error: error instanceof Error ? error.message : "snapshot_failed" }); close(); });
      if (req.signal.aborted) close();
    },
    cancel() { close(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
