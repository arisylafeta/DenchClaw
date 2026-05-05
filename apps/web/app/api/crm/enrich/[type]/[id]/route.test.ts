import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const { loadCrmFieldMapsMock, safeQueryMock, buildEntryProjectionMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
  buildEntryProjectionMock: vi.fn(() => "projection"),
}));

const { getPostgresEnrichmentTargetMock } = vi.hoisted(() => ({
  getPostgresEnrichmentTargetMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: buildEntryProjectionMock,
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
  sqlString: (value: string) => `'${value.replace(/'/g, "''")}'`,
}));

vi.mock("@/lib/crm-postgres/enrich-target", () => ({
  getPostgresEnrichmentTarget: getPostgresEnrichmentTargetMock,
}));

describe("CRM enrich target API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_DB_BACKEND;
  });

  it("returns 400 for invalid type", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const res = await POST(new Request("http://localhost/api/crm/enrich/deal/1", { method: "POST" }), {
      params: Promise.resolve({ type: "deal", id: "1" }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'Type must be "people" or "company".' });
    expect(getPostgresEnrichmentTargetMock).not.toHaveBeenCalled();
  });

  it("uses Postgres helper in postgres mode and preserves deferred response", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    getPostgresEnrichmentTargetMock.mockResolvedValue({
      type: "people",
      id: "person_pg",
      lookupValue: "person@example.com",
    });

    const res = await POST(new Request("http://localhost/api/crm/enrich/people/person_pg", { method: "POST" }), {
      params: Promise.resolve({ type: "people", id: "person_pg" }),
    });

    expect(res.status).toBe(501);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      status: "deferred",
      target: { type: "people", id: "person_pg", lookupValue: "person@example.com" },
    });
    expect(getPostgresEnrichmentTargetMock).toHaveBeenCalledWith("people", "person_pg");
    expect(loadCrmFieldMapsMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
    expect(buildEntryProjectionMock).not.toHaveBeenCalled();
  });
});
