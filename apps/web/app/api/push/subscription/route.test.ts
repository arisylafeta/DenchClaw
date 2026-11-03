import { beforeEach, describe, expect, it, vi } from "vitest";

const user = vi.fn();
const save = vi.fn();
vi.mock("@/lib/auth", () => ({ currentUser: () => user() }));
vi.mock("@/lib/web-push", async () => {
  const actual = await vi.importActual<typeof import("@/lib/web-push")>("@/lib/web-push");
  return { ...actual, pushPublicKey: () => "pub", saveSubscription: (...a: unknown[]) => save(...a), removeSubscription: vi.fn(), sendPushToUser: vi.fn() };
});
import { GET, PUT } from "./route";

const put = (body: unknown) => PUT(new Request("http://x/api/push/subscription", { method: "PUT", body: JSON.stringify(body) }));
beforeEach(() => { user.mockReset(); save.mockReset(); });

describe("push subscription route", () => {
  it("requires a signed-in user", async () => {
    user.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await put({})).status).toBe(401);
  });
  it("returns the public key", async () => {
    user.mockResolvedValue({ id: "u1" });
    expect(await (await GET()).json()).toEqual({ publicKey: "pub" });
  });
  it("stores a valid subscription for the caller only", async () => {
    user.mockResolvedValue({ id: "u1" });
    const res = await put({ subscription: { endpoint: "https://p.example/1", keys: { p256dh: "p", auth: "a" } }, prefs: { input: false } });
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledWith("u1", expect.objectContaining({ endpoint: "https://p.example/1" }), { done: true, input: false }, null);
  });
  it("rejects a malformed subscription", async () => {
    user.mockResolvedValue({ id: "u1" });
    expect((await put({ subscription: { endpoint: "nope" } })).status).toBe(400);
  });
});
