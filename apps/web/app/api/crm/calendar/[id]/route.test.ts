import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { loadCrmFieldMapsMock, safeQueryMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
}));

const { getPostgresCalendarEventMock } = vi.hoisted(() => ({
  getPostgresCalendarEventMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: vi.fn(() => "projection"),
  hydratePeopleByIds: vi.fn(async () => new Map()),
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
  sqlString: (value: string) => `'${value.replace(/'/g, "''")}'`,
}));

vi.mock("@/lib/crm-postgres/calendar", () => ({
  getPostgresCalendarEvent: getPostgresCalendarEventMock,
}));

describe("CRM calendar detail API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_DB_BACKEND;
  });

  it("uses the Postgres calendar detail reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    getPostgresCalendarEventMock.mockResolvedValue({
      event: { id: "event_pg", title: "Postgres Event" },
      organizer: null,
      attendees: [],
      companies: [],
    });

    const res = await GET(
      new Request("http://localhost/api/crm/calendar/event_pg"),
      { params: Promise.resolve({ id: "event_pg" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ event: { id: "event_pg", title: "Postgres Event" } });
    expect(getPostgresCalendarEventMock).toHaveBeenCalledWith("event_pg");
    expect(loadCrmFieldMapsMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});
