import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ currentUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/agent-backend", () => ({ resolveAgentBackend: () => "hermes" }));
const setPin = vi.fn(); const listPins = vi.fn();
vi.mock("@/lib/hermes-pins", () => ({ PinError: class extends Error { constructor(readonly status: number, m: string) { super(m); } }, setPin: (...a: unknown[]) => setPin(...a), listPins: (...a: unknown[]) => listPins(...a) }));
import { currentUser } from "@/lib/auth";
import { PinError } from "@/lib/hermes-pins";
import { GET, PUT } from "./route";
const put = (body: unknown) => PUT(new Request("http://x/api/hermes/pins", { method: "PUT", body: JSON.stringify(body) }));
beforeEach(() => { setPin.mockReset().mockResolvedValue(["k"]); listPins.mockReset().mockResolvedValue(["k"]); });
describe("/api/hermes/pins", () => {
  it("requires a signed-in user", async () => {
    vi.mocked(currentUser).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await put({ key: "k", pinned: true })).status).toBe(401);
    expect(setPin).not.toHaveBeenCalled();
    vi.mocked(currentUser).mockResolvedValue({ id: "u1" } as never);
  });
  it("scopes reads and writes to the caller", async () => {
    expect(await (await GET()).json()).toEqual({ pins: ["k"] });
    expect(listPins).toHaveBeenCalledWith("u1");
    expect(await (await put({ key: "k", pinned: true })).json()).toEqual({ key: "k", pinned: true, pins: ["k"] });
    expect(setPin).toHaveBeenCalledWith("u1", "k", true);
  });
  it("validates the body and maps target errors", async () => {
    expect((await put({ key: "k" })).status).toBe(400);
    expect((await put({ pinned: true })).status).toBe(400);
    setPin.mockRejectedValue(new PinError(404, "chat_not_found"));
    expect((await put({ key: "k", pinned: true })).status).toBe(404);
  });
});
