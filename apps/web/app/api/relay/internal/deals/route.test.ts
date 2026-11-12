import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorised: true, scanFollowUp: vi.fn() }));
vi.mock("@/lib/relay-learn", () => ({ internalAuthorised: () => mocks.authorised }));
vi.mock("@/lib/postgres", () => ({ queryPg: async () => [{ id: "owner-1" }] }));
vi.mock("@/lib/relay", () => ({ RELAY_OWNER_EMAIL: "alex@rebattery.io", scanFollowUp: mocks.scanFollowUp }));

import { POST } from "./route";

describe("POST /api/relay/internal/deals (the scan's call after each run)", () => {
  beforeEach(() => { mocks.authorised = true; mocks.scanFollowUp.mockReset(); });

  it("is not there without the internal secret", async () => {
    mocks.authorised = false;
    const res = await POST(new Request("http://x/api/relay/internal/deals", { method: "POST" }));
    expect(res.status).toBe(404);
    expect(mocks.scanFollowUp).not.toHaveBeenCalled();
  });

  it("runs the deal work and the chase pass for the Relay owner, and says what it did", async () => {
    mocks.scanFollowUp.mockResolvedValue({
      front: { sent: 1, opened: ["bt_1"], queued: ["i1", "i2"], cancelled: 1 },
      chases: { prepared: ["i3"], cancelled: 0, refused: [{ item_id: "i4", reason: "they replied" }] },
      new_supply: 2,
    });
    const res = await POST(new Request("http://x/api/relay/internal/deals", { method: "POST" }));
    expect(mocks.scanFollowUp).toHaveBeenCalledWith("owner-1");
    expect(await res.json()).toEqual({ ok: true, cards_sent: 1, deals_opened: 1, updates_queued: 2, chases: { prepared: 1, cancelled: 1, refused: 1 }, new_supply: 2 });
  });

  it("reports a failed chase pass without failing the call", async () => {
    mocks.scanFollowUp.mockResolvedValue({ front: { sent: 0, opened: [], queued: [], cancelled: 0 }, chases: { error: "mail tool down" }, new_supply: 0 });
    const res = await POST(new Request("http://x/api/relay/internal/deals", { method: "POST" }));
    expect(res.status).toBe(200);
    expect((await res.json()).chases).toEqual({ error: "mail tool down" });
  });
});
