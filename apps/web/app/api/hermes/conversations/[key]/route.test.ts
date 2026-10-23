import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({ id: "recipient", email: "recipient@example.test", displayName: "Recipient" })),
  ALLOWED_EMAILS: new Set(),
}));
vi.mock("@/lib/postgres", () => ({ queryPg: vi.fn() }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/hermes-client", () => ({ stopNativeHermesStream: vi.fn(() => true) }));
vi.mock("@/lib/hermes-gateway/transport-flag", () => ({ hermesChatTransport: () => "sse" }));
vi.mock("@/lib/hermes-native", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/hermes-native")>(),
  assertProfile: vi.fn(),
  groupRpc: vi.fn(async () => ({})),
  nativeFetch: vi.fn(async () => Response.json({})),
  readConversation: vi.fn(async () => ({ key: "synthetic" })),
}));

import { queryPg } from "@/lib/postgres";
import { conversationKey } from "@/lib/hermes-conversations";
import { groupRpc, nativeFetch, readConversation } from "@/lib/hermes-native";
import { stopNativeHermesStream } from "@/lib/hermes-client";
import { PATCH, POST } from "./route";

type AccessRow = { owner_id: string; creator_id: string; origin: string; visibility: string; version: number; deleted_at: string | null };
let row: AccessRow;
beforeEach(() => {
  vi.clearAllMocks();
  row = { owner_id: "owner", creator_id: "owner", origin: "crm", visibility: "team", version: 1, deleted_at: null };
  vi.mocked(queryPg).mockImplementation(async () => [{ ...row }]);
});

const cases = [
  { name: "group send", handler: POST, kind: "group", body: { message: "Hello", eventId: "event-1" }, rpc: "groups.send" },
  { name: "group rename", handler: PATCH, kind: "group", body: { title: "Renamed" }, rpc: "groups.rename" },
  { name: "native rename", handler: PATCH, kind: "solo", body: { title: "Renamed" }, rpc: null },
  { name: "group stop", handler: POST, kind: "group", body: { action: "stop", eventId: "stop-1" }, rpc: "groups.stop" },
  { name: "native stream stop", handler: POST, kind: "solo", body: { action: "stop" }, rpc: null },
] as const;

function deferredRequest(method: string) {
  let start!: () => void;
  let release!: (body: unknown) => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const body = new Promise<unknown>((resolve) => { release = resolve; });
  const req = new Request("http://localhost/api/hermes/conversations/synthetic", { method });
  vi.spyOn(req, "json").mockImplementation(() => { start(); return body; });
  return { req, started, release };
}

function context(kind: "group" | "solo") {
  return { params: Promise.resolve({ key: conversationKey(kind, "synthetic", kind === "solo" ? "agent" : "") }) };
}

function expectNoMutations() {
  expect(groupRpc).not.toHaveBeenCalled();
  expect(nativeFetch).not.toHaveBeenCalled();
  expect(stopNativeHermesStream).not.toHaveBeenCalled();
  expect(readConversation).not.toHaveBeenCalled();
}

describe("native mutation authorization after deferred request bodies", () => {
  for (const scenario of cases) {
    for (const change of ["revoked", "deleted"] as const) {
      it(`does not mutate ${scenario.name} when access is ${change} during body parsing`, async () => {
        const request = deferredRequest(scenario.handler === PATCH ? "PATCH" : "POST");
        const pending = scenario.handler(request.req, context(scenario.kind));
        await request.started;
        expectNoMutations();
        if (change === "revoked") { row.visibility = "private"; }
        else { row.deleted_at = "2026-01-01T00:00:00Z"; }
        row.version++;
        request.release(scenario.body);
        const response = await pending;
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
        expectNoMutations();
      });
    }

    it(`allows ${scenario.name} while access remains shared`, async () => {
      const request = deferredRequest(scenario.handler === PATCH ? "PATCH" : "POST");
      const pending = scenario.handler(request.req, context(scenario.kind));
      await request.started;
      request.release(scenario.body);
      expect((await pending).status).toBe(200);
      if (scenario.rpc) {
        expect(groupRpc).toHaveBeenCalledExactlyOnceWith(scenario.rpc, expect.objectContaining({ room_id: "synthetic" }));
        expect(nativeFetch).not.toHaveBeenCalled();
        expect(stopNativeHermesStream).not.toHaveBeenCalled();
      } else if (scenario.handler === PATCH) {
        expect(nativeFetch).toHaveBeenCalledExactlyOnceWith("agent", "/api/sessions/synthetic", { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) });
        expect(groupRpc).not.toHaveBeenCalled();
        expect(stopNativeHermesStream).not.toHaveBeenCalled();
      } else {
        expect(stopNativeHermesStream).toHaveBeenCalledExactlyOnceWith("agent", "synthetic");
        expect(groupRpc).not.toHaveBeenCalled();
        expect(nativeFetch).not.toHaveBeenCalled();
      }
    });
  }
});
