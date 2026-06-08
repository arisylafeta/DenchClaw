import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { loadCrmFieldMapsMock, safeQueryMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
}));

const { getPostgresCalendarEventsMock } = vi.hoisted(() => ({
  getPostgresCalendarEventsMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: vi.fn(() => "projection"),
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
}));

vi.mock("@/lib/crm-postgres/calendar", () => ({
  getPostgresCalendarEvents: getPostgresCalendarEventsMock,
}));

describe("CRM calendar API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_DB_BACKEND;
  });

  it("uses the Postgres calendar reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
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
    expect(loadCrmFieldMapsMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});
