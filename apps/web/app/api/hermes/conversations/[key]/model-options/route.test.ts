import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ currentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: vi.fn(() => "hermes") }));
vi.mock("@/lib/hermes-gateway/transport-flag", () => ({ hermesChatTransport: vi.fn(() => "gateway") }));
vi.mock("@/lib/hermes-native", () => ({ assertProfile: vi.fn((profile: string) => { if (profile !== "ari") { throw new Error("unknown"); } }) }));
vi.mock("@/lib/hermes-gateway/manager", () => ({ getHermesGatewayManager: () => ({ onServerRequest: vi.fn() }) }));
import { currentUser } from "@/lib/auth";
import { resolveAgentBackend } from "@/lib/agent-backend";
import { hermesChatTransport } from "@/lib/hermes-gateway/transport-flag";
import { ChatServiceError, getHermesChatService } from "@/lib/hermes-gateway/chat-service";
import { conversationKey } from "@/lib/hermes-conversations";
import { GET } from "./route";
import { POST as model } from "../model/route";
import { POST as reasoning } from "../reasoning/route";
const key = conversationKey("solo", "one", "ari");
const context = { params: Promise.resolve({ key }) };
const handlers = [GET, model, reasoning];
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
describe("composer control routes", () => {
  it("authenticates every endpoint before touching the service", async () => {
    const options = vi.spyOn(getHermesChatService(), "modelOptions");
    const command = vi.spyOn(getHermesChatService(), "command");
    for (const handler of handlers) {
      vi.mocked(currentUser).mockResolvedValueOnce(null);
      expect((await handler(new Request("http://local"), context)).status).toBe(401);
    }
    expect(options).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
  it("rejects unknown profiles and malformed keys on every endpoint", async () => {
    const options = vi.spyOn(getHermesChatService(), "modelOptions");
    const command = vi.spyOn(getHermesChatService(), "command");
    for (const handler of handlers) {
      for (const [badKey, status] of [[conversationKey("solo", "one", "foreign"), 404], ["bad-key", 400]] as const) {
        expect((await handler(new Request("http://local"), { params: Promise.resolve({ key: badKey }) })).status).toBe(status);
      }
    }
    expect(options).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });
  it("rejects disabled Hermes and SSE transport on every endpoint", async () => {
    for (const handler of handlers) {
      vi.mocked(resolveAgentBackend).mockReturnValueOnce("openclaw");
      expect((await handler(new Request("http://local"), context)).status).toBe(404);
      vi.mocked(hermesChatTransport).mockReturnValueOnce("sse");
      expect((await handler(new Request("http://local"), context)).status).toBe(409);
    }
  });
  it("returns the inventory and live reasoning payload without dropping native fields", async () => {
    const payload = { fast:false, providers: [], model: "test", provider: "openai", reasoning: { value: "high", display: "hide" } };
    const options = vi.spyOn(getHermesChatService(), "modelOptions").mockResolvedValueOnce(payload);
    const response = await GET(new Request("http://local"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(options).toHaveBeenCalledWith(key,expect.objectContaining({id:"user"}));
  });
  it("forwards model confirmation and reasoning bodies and preserves native mutation results", async () => {
    const warning = { key: "model", value: "expensive", confirm_required: true, confirm_message: "Costs more", scope: "session" };
    const command = vi.spyOn(getHermesChatService(), "command").mockResolvedValueOnce(warning).mockResolvedValueOnce({ key: "model", value: "expensive", deferred: true }).mockResolvedValueOnce({ key: "reasoning", value: "none" });
    for (const [handler, body, expected] of [
      [model, { model: "expensive", provider: "openai" }, warning],
      [model, { model: "expensive", provider: "openai", confirm: true }, { key: "model", value: "expensive", deferred: true }],
      [reasoning, { effort: "none" }, { key: "reasoning", value: "none" }],
    ] as const) {
      const response = await handler(new Request("http://local", { method: "POST", body: JSON.stringify(body) }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    expect(command.mock.calls).toEqual([
      [key, "model", { model: "expensive", provider: "openai" },expect.objectContaining({id:"user"})],
      [key, "model", { model: "expensive", provider: "openai", confirm: true },expect.objectContaining({id:"user"})],
      [key, "reasoning", { effort: "none" },expect.objectContaining({id:"user"})],
    ]);
  });
  it("maps read-only and non-live failures to 409", async () => {
    vi.spyOn(getHermesChatService(), "modelOptions").mockRejectedValueOnce(new ChatServiceError(409, "session_not_live"));
    expect((await GET(new Request("http://local"), context)).status).toBe(409);
    const command = vi.spyOn(getHermesChatService(), "command");
    for (const handler of [model, reasoning]) {
      command.mockRejectedValueOnce(new ChatServiceError(409, "automation_read_only"));
      const response = await handler(new Request("http://local", { method: "POST", body: "{}" }), context);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "automation_read_only" });
    }
  });
  it("rejects malformed JSON and non-object bodies before invoking a mutation", async () => {
    const command = vi.spyOn(getHermesChatService(), "command");
    for (const handler of [model, reasoning]) {
      for (const body of ["{", "null", "[]"]) {
        expect((await handler(new Request("http://local", { method: "POST", body }), context)).status).toBe(400);
      }
    }
    expect(command).not.toHaveBeenCalled();
  });
});
