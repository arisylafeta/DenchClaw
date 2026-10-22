import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeData } from "@/lib/home-metrics";

const { guard, listWeeks, lastCollectedAt, followUps } = vi.hoisted(() => ({
  guard: vi.fn(),
  listWeeks: vi.fn(),
  lastCollectedAt: vi.fn(),
  followUps: vi.fn(),
}));
vi.mock("@/lib/bulk-trades-route", () => ({ guardBulkTrades: guard }));
vi.mock("@/lib/crm-postgres/marketplace-pulse", () => ({ listWeeks }));
vi.mock("@/lib/crm-postgres/home", () => ({ lastCollectedAt }));
vi.mock("@/lib/marketplace-pulse-platform", () => ({ followUps }));

import { GET } from "./route";

afterEach(() => vi.clearAllMocks());

describe("GET /api/home", () => {
  it("returns the guard's response when the user is not signed in", async () => {
    guard.mockResolvedValue({ response: Response.json({ error: "Unauthorized" }, { status: 401 }) });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(guard).toHaveBeenCalledWith("Home");
    expect(listWeeks).not.toHaveBeenCalled();
  });

  it("builds the page from the weekly numbers, and still loads when ReBattery cannot be read", async () => {
    guard.mockResolvedValue({ userId: "u1", email: "alex@rebattery.io" });
    listWeeks.mockResolvedValue({ weeks: [{ week_start: "2026-10-12", values: { viewed_listing: 50 } }], collected_at: null });
    lastCollectedAt.mockResolvedValue("2026-10-18T08:40:59Z");
    followUps.mockRejectedValue(new Error("down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as HomeData;
    expect(listWeeks).toHaveBeenCalledWith(16);
    expect(body.freshness).toMatchObject({ collected_at: "2026-10-18T08:40:59Z", stale: true });
    expect(body.cards).toHaveLength(5);
    expect(body.follow_up_error).toMatch(/Could not read ReBattery/);
  });
});
