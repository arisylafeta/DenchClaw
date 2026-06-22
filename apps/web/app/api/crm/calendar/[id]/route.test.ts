import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getPostgresCalendarEventMock } = vi.hoisted(() => ({
  getPostgresCalendarEventMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/calendar", () => ({
  getPostgresCalendarEvent: getPostgresCalendarEventMock,
}));

describe("CRM calendar detail API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Postgres calendar detail reader", async () => {
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
  });
});
