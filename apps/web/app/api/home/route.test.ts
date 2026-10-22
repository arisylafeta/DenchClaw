import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeData } from "@/lib/home";
import type { PlatformRows } from "@/lib/home-platform";

const { guard, listWeeks, lastCollectedAt, bulkRows, platformRows } = vi.hoisted(() => ({
  guard: vi.fn(),
  listWeeks: vi.fn(),
  lastCollectedAt: vi.fn(),
  bulkRows: vi.fn(),
  platformRows: vi.fn(),
}));
vi.mock("@/lib/bulk-trades-route", () => ({ guardBulkTrades: guard }));
vi.mock("@/lib/crm-postgres/marketplace-pulse", () => ({ listWeeks }));
vi.mock("@/lib/crm-postgres/home", () => ({ lastCollectedAt, bulkRows }));
vi.mock("@/lib/home-platform-read", () => ({ platformRows }));

import { GET } from "./route";

const PLATFORM: PlatformRows = {
  deals: [{ id: "d1", created_at: "2026-10-02T15:33:25Z", supplier_account_id: "s", counterparty_account_id: "b" }],
  payments: [{ deal_id: "d1", status: "captured", payment_purpose: "initial", amount: "1860", currency: "gbp", platform_fee_amount: "155", captured_at: "2026-10-02T15:33:27Z", created_at: "2026-10-02T15:33:26Z" }],
  offers: [], conversations: [], messages: [], accountEmails: new Map(), accountNames: new Map(),
};
const BULK = { lots: [{ id: "l", title: "Lot", trade_stage: "Closing", value: "$1", last_touched: null, latest_activity_at: null, updated_at: "2026-10-01T00:00:00Z", stage_event_at: null }], demand: [], bids: [], buyers: [] };

afterEach(() => vi.clearAllMocks());

function signedIn() {
  guard.mockResolvedValue({ userId: "u1", email: "alex@rebattery.io" });
  listWeeks.mockResolvedValue({ weeks: [{ week_start: "2026-10-12", values: { visitors: 97, viewed_listing: 50 } }], collected_at: null });
  lastCollectedAt.mockResolvedValue("2026-10-18T08:40:59Z");
  bulkRows.mockResolvedValue(BULK);
  platformRows.mockResolvedValue(PLATFORM);
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("GET /api/home", () => {
  it("returns the guard's response when the user is not signed in", async () => {
    guard.mockResolvedValue({ response: Response.json({ error: "Unauthorized" }, { status: 401 }) });
    const response = await GET();
    expect(response.status).toBe(401);
    expect(guard).toHaveBeenCalledWith("Home");
    expect(listWeeks).not.toHaveBeenCalled();
    expect(platformRows).not.toHaveBeenCalled();
  });

  it("builds the page from all three sources", async () => {
    signedIn();
    const body = (await (await GET()).json()) as HomeData;
    expect(listWeeks).toHaveBeenCalledWith(16);
    expect(body.header.funnel).toMatchObject({ collected_at: "2026-10-18T08:40:59Z", stale: true });
    expect(body.fees?.ytd_gbp).toBe(155);
    expect(body.bulk_goal?.closing).toEqual([{ title: "Lot", value: "$1" }]);
    expect(body.errors).toEqual({ platform: null, crm: null });
  });

  it("still loads the CRM parts when ReBattery cannot be read", async () => {
    signedIn();
    platformRows.mockRejectedValue(new Error("down"));
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as HomeData;
    expect(body.errors.platform).toMatch(/Could not read ReBattery/);
    expect(body.marketplace).toBeNull();
    expect(body.bulk?.order_book.open).toBe(1);
  });

  it("still loads the platform parts when the CRM cannot be read", async () => {
    signedIn();
    bulkRows.mockRejectedValue(new Error("pg down"));
    const body = (await (await GET()).json()) as HomeData;
    expect(body.errors.crm).toMatch(/Could not read the CRM/);
    expect(body.bulk).toBeNull();
    expect(body.funnel).toBeNull();
    expect(body.fees?.ytd_gbp).toBe(155);
  });
});
