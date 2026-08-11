import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));

const { loadCrmFieldMapsMock, safeQueryMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
}));

const { getPostgresInboxThreadMock } = vi.hoisted(() => ({
  getPostgresInboxThreadMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: vi.fn(() => "projection"),
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
  sqlString: (value: string) => `'${value.replace(/'/g, "''")}'`,
}));

vi.mock("@/lib/crm-postgres/inbox-thread", () => ({
  getPostgresInboxThread: getPostgresInboxThreadMock,
}));

describe("CRM inbox thread API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_DB_BACKEND;
  });

  it("uses the Postgres inbox thread reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    getPostgresInboxThreadMock.mockResolvedValue({
      thread_id: "thread_pg",
      messages: [],
      people: [],
      body_hydration: {
        attempted: 0,
        fetched: 0,
        failed: 0,
        skipped: false,
        rehydrated_plain_text: 0,
      },
    });

    const res = await GET(
      new Request("http://localhost/api/crm/inbox/thread_pg"),
      { params: Promise.resolve({ threadId: "thread_pg" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ thread_id: "thread_pg", messages: [] });
    expect(getPostgresInboxThreadMock).toHaveBeenCalledWith(
      "thread_pg",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(loadCrmFieldMapsMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });
});
