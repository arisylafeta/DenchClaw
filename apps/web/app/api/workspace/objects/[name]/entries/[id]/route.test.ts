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

const updatePostgresEntry = vi.fn(async () => ({ updatedCount: 1 }));
const deletePostgresEntry = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/crm-postgres/entry-mutations", () => ({
  createPostgresEntry: vi.fn(),
  updatePostgresEntry,
  deletePostgresEntry,
  bulkDeletePostgresEntries: vi.fn(),
}));

describe("entry detail route", () => {
  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
    vi.clearAllMocks();
  });

  it("uses postgres detail reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { findDuckDBForObject, duckdbQueryOnFile, duckdbExecOnFile } = await import("@/lib/workspace");
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/workspace/objects/people/entries/p1"), {
      params: Promise.resolve({ name: "people", id: "p1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ entry: { entry_id: "p1" } });
    expect(getPostgresEntryData).toHaveBeenCalledWith("people", "p1");
    expect(findDuckDBForObject).not.toHaveBeenCalled();
    expect(duckdbQueryOnFile).not.toHaveBeenCalled();
    expect(duckdbExecOnFile).not.toHaveBeenCalled();
  });

  it("uses postgres updater for PATCH when backend is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { findDuckDBForObject, duckdbQueryOnFile, duckdbExecOnFile } = await import("@/lib/workspace");
    const { PATCH } = await import("./route");

    const response = await PATCH(new Request("http://localhost/api/workspace/objects/people/entries/p1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { first_name: "Ari" } }),
    }), {
      params: Promise.resolve({ name: "people", id: "p1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, updatedCount: 1 });
    expect(updatePostgresEntry).toHaveBeenCalledWith("people", "p1", { first_name: "Ari" });
    expect(findDuckDBForObject).not.toHaveBeenCalled();
    expect(duckdbQueryOnFile).not.toHaveBeenCalled();
    expect(duckdbExecOnFile).not.toHaveBeenCalled();
  });

  it("uses postgres deleter for DELETE when backend is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { findDuckDBForObject, duckdbQueryOnFile, duckdbExecOnFile } = await import("@/lib/workspace");
    const { DELETE } = await import("./route");

    const response = await DELETE(new Request("http://localhost/api/workspace/objects/people/entries/p1", {
      method: "DELETE",
    }), {
      params: Promise.resolve({ name: "people", id: "p1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(deletePostgresEntry).toHaveBeenCalledWith("people", "p1");
    expect(findDuckDBForObject).not.toHaveBeenCalled();
    expect(duckdbQueryOnFile).not.toHaveBeenCalled();
    expect(duckdbExecOnFile).not.toHaveBeenCalled();
  });
});
