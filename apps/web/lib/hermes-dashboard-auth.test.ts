import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { once } from "node:events";
vi.mock("node:fs/promises", async (original) => ({ ...await original<object>(), readFile: vi.fn(async () => "synthetic-password\n") }));
vi.mock("./workspace", () => ({ discoverWorkspaces: () => [], readActiveProfileName: () => null }));
let server: WebSocketServer | undefined;
afterEach(async () => {
  if (server) { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks();
});
async function setup() {
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 }); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  vi.stubEnv("HERMES_GATEWAY_WS_URL", `ws://127.0.0.1:${address.port}/api/ws`);
  vi.stubEnv("HERMES_GATEWAY_TOKEN", ""); vi.stubEnv("HERMES_GATEWAY_USERNAME", "service-user");
  vi.stubEnv("HERMES_GATEWAY_PASSWORD_FILE", "/synthetic/credential");
}
describe("authenticated dashboard connection", () => {
  it.each(["", "__Host-", "__Secure-"])("signs in once with cookie prefix %s and keeps a healthy socket after token expiry", async (prefix) => {
    await setup();
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.pathname).toBe("/auth/password-login"); expect(url.protocol).toBe("http:");
      expect(JSON.parse(init.body as string)).toEqual({ provider: "basic", username: "service-user", password: "synthetic-password" });
      return Response.json({ ok: true }, { headers: { "Set-Cookie": `${prefix}hermes_session_at="synthetic-session="; Max-Age=120; HttpOnly; Path=/` } });
    });
    vi.stubGlobal("fetch", fetchMock);
    server!.on("connection", (socket, req) => {
      expect(new URL(req.url!, "http://localhost").searchParams.get("token")).toBe("synthetic-session=");
      socket.on("message", (raw) => { const message = JSON.parse(raw.toString()); socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { rooms: [] } })); });
    });
    const { groupRpc } = await import("./hermes-native");
    expect(await Promise.all([groupRpc("groups.list"), groupRpc("groups.list")])).toEqual([{ rooms: [] }, { rooms: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(server!.clients.size).toBe(1);
    const later = Date.now() + 300_000; vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await groupRpc("groups.list")).toEqual({ rooms: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(server!.clients.size).toBe(1);
  });
  it("redacts failed sign-in responses and rejects before opening a socket", async () => {
    await setup(); vi.stubGlobal("fetch", vi.fn(async () => new Response("sensitive upstream body", { status: 401 })));
    const { groupRpc } = await import("./hermes-native");
    const failures = await Promise.allSettled([groupRpc("groups.list"), groupRpc("groups.list")]);
    expect(failures.map((result) => result.status === "rejected" ? result.reason.message : "unexpected success")).toEqual(["Hermes dashboard sign-in failed", "Hermes dashboard sign-in failed"]);
    await expect(groupRpc("groups.list")).rejects.toThrow("temporarily unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(server!.clients.size).toBe(0);
  });
});
