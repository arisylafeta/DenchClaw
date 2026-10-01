import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listGET } from "./route";
import { GET as detailGET } from "./[id]/route";

const { currentUser, queryPg } = vi.hoisted(() => ({ currentUser: vi.fn(), queryPg: vi.fn() }));
vi.mock("@/lib/auth", () => ({ currentUser }));
vi.mock("@/lib/postgres", () => ({ queryPg }));

const request = new Request("http://localhost/api/campaigns/missing");
const params = { params: Promise.resolve({ id: "missing" }) };

beforeEach(() => {
  vi.stubEnv("CRM_DB_BACKEND", "postgres");
  currentUser.mockResolvedValue({ id: "signed-in-user", email: "reader@example.test" });
  queryPg.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  currentUser.mockReset();
});

describe("read-only campaign endpoints", () => {
  it("denies anonymous access to both collection and recipient detail before reading CRM data", async () => {
    currentUser.mockResolvedValue(null);
    const responses = [await listGET(), await detailGET(request, params)];
    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    for (const response of responses) { expect(await response.json()).toEqual({ error: "Unauthorized" }); }
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("returns 404 for a campaign that does not exist", async () => {
    queryPg.mockResolvedValueOnce([]);
    const response = await detailGET(request, params);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Campaign not found" });
  });

  it("refuses unsupported backends instead of touching PostgreSQL", async () => {
    vi.stubEnv("CRM_DB_BACKEND", "duckdb");
    const responses = [await listGET(), await detailGET(request, params)];
    expect(responses.map((response) => response.status)).toEqual([503, 503]);
    for (const response of responses) { expect(await response.json()).toEqual({ error: "Campaigns requires the Postgres backend" }); }
    expect(queryPg).not.toHaveBeenCalled();
  });
});
