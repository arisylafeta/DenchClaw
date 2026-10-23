import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
const { guard, activity, engagement } = vi.hoisted(() => ({ guard: vi.fn(), activity: vi.fn(), engagement: vi.fn() }));
vi.mock("@/lib/bulk-trades-route", () => ({ guardBulkTrades: guard }));
vi.mock("@/lib/campaign-activity-server", () => ({ getCampaignActivity: activity }));
vi.mock("@/lib/crm-postgres/campaign-engagement", () => ({ readCampaignEngagement: engagement }));
const context = { params: Promise.resolve({ id: "campaign-one" }) };
beforeEach(() => { vi.resetAllMocks(); guard.mockResolvedValue({}); });
describe("campaign activity engagement payload", () => {
  it("retains unavailable website evidence while returning email observations", async () => {
    activity.mockResolvedValue({ campaign_id: "campaign-one", status: "unavailable", destinations: [] });
    engagement.mockResolvedValue([{ recipient_key: "p1", return_sessions: 2 }]);
    const response = await GET(new Request("https://example.com"), context);
    expect(await response.json()).toEqual({ campaign_id: "campaign-one", status: "unavailable", destinations: [], engagement: [{ recipient_key: "p1", return_sessions: 2 }] });
    expect(engagement).toHaveBeenCalledWith("campaign-one", { showInternal: false, crmOnly: false });
  });
  it("passes recipient filters to engagement", async () => {
    activity.mockResolvedValue({ campaign_id: "campaign-one", status: "unavailable", destinations: [] });
    engagement.mockResolvedValue([]);
    await GET(new Request("https://example.com?identity=supply&event=opened&to=reader%40example.test&since=2026-10-01"), context);
    expect(engagement).toHaveBeenCalledWith("campaign-one", { identity: "supply", event: "opened", to: "reader@example.test", since: "2026-10-01", showInternal: false, crmOnly: false });
  });
  it("does not read observations without permission", async () => {
    guard.mockResolvedValue({ response: Response.json({ error: "Unauthorised" }, { status: 401 }) });
    expect((await GET(new Request("https://example.com"), context)).status).toBe(401);
    expect(activity).not.toHaveBeenCalled(); expect(engagement).not.toHaveBeenCalled();
  });
  it("does not return observations for a missing campaign", async () => {
    activity.mockResolvedValue(null);
    expect((await GET(new Request("https://example.com"), context)).status).toBe(404);
    expect(engagement).not.toHaveBeenCalled();
  });
});
