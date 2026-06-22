import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getPostgresCalendarEventsMock } = vi.hoisted(() => ({
  getPostgresCalendarEventsMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/calendar", () => ({
  getPostgresCalendarEvents: getPostgresCalendarEventsMock,
}));

describe("CRM calendar API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Postgres calendar reader", async () => {
    getPostgresCalendarEventsMock.mockResolvedValue({ events: [], total: 0, limit: 25, offset: 5 });

    const res = await GET(new Request("http://localhost/api/crm/calendar?limit=25&offset=5&q=demo&from=2026-01-01&to=2026-02-01"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ events: [], total: 0, limit: 25, offset: 5 });
    expect(getPostgresCalendarEventsMock).toHaveBeenCalledWith({
      search: "demo",
      fromIso: "2026-01-01",
      toIso: "2026-02-01",
      limit: 25,
      offset: 5,
    });
  });
});
