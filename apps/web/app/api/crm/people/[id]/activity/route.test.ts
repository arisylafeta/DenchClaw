import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getPostgresPersonActivityMock } = vi.hoisted(() => ({
  getPostgresPersonActivityMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/activity", () => ({
  getPostgresPersonActivity: getPostgresPersonActivityMock,
}));

describe("CRM person activity API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when person id is missing", async () => {
    const res = await GET(new Request("http://localhost/api/crm/people/%20/activity"), {
      params: Promise.resolve({ id: "  " }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Missing person id." });
    expect(getPostgresPersonActivityMock).not.toHaveBeenCalled();
  });

  it("uses the Postgres activity helper", async () => {
    getPostgresPersonActivityMock.mockResolvedValue({
      activities: [{ id: "int_1", type: "Email", direction: "Sent", occurred_at: "2026-05-01T00:00:00.000Z", email: null, event: null }],
      total: 1,
      has_more: false,
    });

    const res = await GET(
      new Request("http://localhost/api/crm/people/person_pg/activity?limit=25&offset=10"),
      { params: Promise.resolve({ id: "person_pg" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      activities: [{ id: "int_1", type: "Email", direction: "Sent", occurred_at: "2026-05-01T00:00:00.000Z", email: null, event: null }],
      total: 1,
      has_more: false,
    });
    expect(getPostgresPersonActivityMock).toHaveBeenCalledWith({
      personId: "person_pg",
      limit: 25,
      offset: 10,
    });
  });
});
