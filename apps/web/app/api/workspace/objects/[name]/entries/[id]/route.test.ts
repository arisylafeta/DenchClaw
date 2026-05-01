import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace", () => ({
  duckdbQueryOnFile: vi.fn(() => []),
  duckdbExecOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(() => null),
  discoverDuckDBPaths: vi.fn(() => []),
  parseRelationValue: vi.fn(() => []),
}));

const getPostgresEntryData = vi.fn(async () => ({
  object: { id: "people", name: "people" },
  fields: [],
  entry: { entry_id: "p1" },
  relationLabels: {},
  relationFaviconUrls: {},
  reverseRelations: [],
  effectiveDisplayField: "id",
}));

vi.mock("@/lib/crm-postgres/entry-read", () => ({ getPostgresEntryData }));

describe("entry detail route", () => {
  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
    vi.clearAllMocks();
  });

  it("uses postgres detail reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/workspace/objects/people/entries/p1"), {
      params: Promise.resolve({ name: "people", id: "p1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ entry: { entry_id: "p1" } });
    expect(getPostgresEntryData).toHaveBeenCalledWith("people", "p1");
  });
});
