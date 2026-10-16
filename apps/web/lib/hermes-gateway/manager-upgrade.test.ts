import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { expect, it, vi } from "vitest";
vi.mock("../hermes-native", () => ({ dashboardToken: vi.fn(), invalidateDashboardToken: vi.fn() }));
import { HermesGatewayManager } from "./manager";

it("refreshes a cached token rejected before WebSocket acceptance", async () => {
  const server = createServer();
  const ws = new WebSocketServer({ noServer: true });
  const seen: string[] = [];
  server.on("upgrade", (request, socket, head) => {
    const token = new URL(request.url!, "http://local").searchParams.get("token")!;
    seen.push(token);
    if (token === "expired") { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
    ws.handleUpgrade(request, socket, head, peer => {
      peer.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { replay_epoch: "test" } } }));
      peer.on("message", bytes => {
        const frame = JSON.parse(bytes.toString()) as { id: string };
        peer.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} }));
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing listener");
  let token = "expired";
  const invalidate = vi.fn(() => { token = "fresh"; });
  const manager = new HermesGatewayManager({ url: `ws://127.0.0.1:${address.port}/api/ws`, tokenProvider: async () => token, invalidateToken: invalidate, random: () => 0 });
  try {
    const connected = new Promise<void>(resolve => manager.subscribeNotices(notice => { if (notice.state === "connected") resolve(); }));
    await expect(manager.connect()).rejects.toThrow("401");
    await connected;
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["expired", "fresh"]);
  } finally {
    manager.shutdown();
    for (const peer of ws.clients) peer.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
