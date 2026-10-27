import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.fn();
vi.mock("./auth", () => ({ currentUser: () => currentUser() }));
vi.mock("./relay", () => ({ canUseRelay: (e: string) => e.toLowerCase() === "alex@rebattery.io", RelayError: class extends Error {} }));
vi.mock("./mail-draft-actions", () => ({ DraftActionError: class extends Error {} }));

const { guardRelay } = await import("./relay-route");

describe("guardRelay", () => {
  beforeEach(() => { process.env.CRM_DB_BACKEND = "postgres"; currentUser.mockReset(); });
  it("lets Alex in", async () => {
    currentUser.mockResolvedValue({ id: "a", email: "Alex@rebattery.io", displayName: "Alex" });
    expect("user" in await guardRelay()).toBe(true);
  });
  it("hides Relay from everyone else", async () => {
    currentUser.mockResolvedValue({ id: "b", email: "ari@rebattery.io", displayName: "Ari" });
    const r = await guardRelay();
    expect("response" in r && r.response.status).toBe(404);
  });
  it("requires sign-in", async () => {
    currentUser.mockResolvedValue(null);
    const r = await guardRelay();
    expect("response" in r && r.response.status).toBe(401);
  });
});
