import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ currentUser: vi.fn(async () => ({ id: "user" })) }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
vi.mock("@/lib/hermes-native", () => ({ assertProfile: vi.fn((profile: string) => { if (profile !== "ari") {throw new Error("unknown");} }) }));
vi.mock("@/lib/hermes-gateway/manager", () => ({ getHermesGatewayManager: () => ({ onServerRequest: vi.fn() }) }));
import { currentUser } from "@/lib/auth";
import { getHermesChatService } from "@/lib/hermes-gateway/chat-service";
import { conversationKey } from "@/lib/hermes-conversations";
import { GET } from "./route";
const key = conversationKey("solo", "one", "ari");
beforeEach(() => vi.clearAllMocks());
it("requires authentication before loading history", async () => {
  vi.mocked(currentUser).mockResolvedValueOnce(null);
  expect((await GET(new Request("http://local?before=250"), { params: Promise.resolve({ key }) })).status).toBe(401);
});
it("checks profile ownership and forwards a bounded history cursor", async () => {
  const page = vi.spyOn(getHermesChatService(), "historyPage").mockResolvedValueOnce({ messages: [{ id: "1", role: "user", text: "earlier" }], olderCursor: "50" });
  const response = await GET(new Request("http://local?before=250&limit=200"), { params: Promise.resolve({ key }) });
  expect(response.status).toBe(200);
  expect(page).toHaveBeenCalledWith(key, "250", 200,expect.objectContaining({id:"user"}));
  expect(await response.json()).toEqual({ messages: [{ id: "1", role: "user", text: "earlier" }], olderCursor: "50" });
  expect((await GET(new Request("http://local?before=250"), { params: Promise.resolve({ key: conversationKey("solo", "one", "foreign") }) })).status).toBe(404);
  expect(page).toHaveBeenCalledTimes(1);
  page.mockRestore();
});
