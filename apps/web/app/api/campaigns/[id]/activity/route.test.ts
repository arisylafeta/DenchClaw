import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { currentUser, readActivity } = vi.hoisted(() => ({ currentUser: vi.fn(), readActivity: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser }));
vi.mock("@/lib/campaign-activity-server", () => ({ getCampaignActivity: readActivity }));

const request = new Request("http://localhost/api/campaigns/customer/activity");
const params = { params: Promise.resolve({ id: "customer" }) };
beforeEach(() => {
  vi.stubEnv("CRM_DB_BACKEND", "postgres");
  currentUser.mockResolvedValue({ id: "signed-in", email: "reader@example.test" });
  readActivity.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  currentUser.mockReset();
});

describe("campaign activity actor boundary", () => {
  it("denies anonymous access before reading private manifests or the provider", async () => {
    currentUser.mockResolvedValue(null);
    const response = await GET(request, params);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(readActivity).not.toHaveBeenCalled();
  });

  it("refuses unsupported CRM backends before activity reads", async () => {
    vi.stubEnv("CRM_DB_BACKEND", "duckdb");
    const response = await GET(request, params);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Campaign activity requires the Postgres backend" });
    expect(readActivity).not.toHaveBeenCalled();
  });

  it("distinguishes a missing campaign from a known campaign with unavailable evidence", async () => {
    readActivity.mockResolvedValueOnce(null);
    const missing = await GET(request, params);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Campaign not found" });
    readActivity.mockResolvedValueOnce({ campaign_id: "customer", status: "unavailable", unavailable_reason: "credentials_missing",
      observed_at: null, period_start: null, period_end: null, totals: null, destinations: [] });
    const unavailable = await GET(request, params);
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({ status: "unavailable", totals: null });
    expect(unavailable.headers.get("cache-control")).toBe("private, no-store");
  });
});
