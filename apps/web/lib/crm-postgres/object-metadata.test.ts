import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());
const withPgTransaction = vi.hoisted(() => vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })));

vi.mock("../postgres", () => ({
  queryPg,
  withPgTransaction,
}));

vi.mock("../workspace", () => ({
  duckdbQueryAsync: vi.fn(() => {
    throw new Error("DuckDB should not be used");
  }),
}));

describe("crm-postgres object metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    queryPg.mockReset();
    withPgTransaction.mockReset();
    withPgTransaction.mockImplementation(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) }));
  });

  it("loads an object by name from crm_objects", async () => {
    const postgres = await import("../postgres");
    vi.mocked(postgres.queryPg).mockResolvedValueOnce([{ id: "obj1", name: "people", display_field: "Full Name" }]);
    const { getPostgresObjectByName } = await import("./object-metadata");
    await expect(getPostgresObjectByName("people")).resolves.toMatchObject({ id: "obj1" });
    expect(postgres.queryPg).toHaveBeenCalledWith(expect.stringContaining("from crm_objects"), ["people"]);
  });

  it("loads fields and statuses ordered by sort_order", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "f1", object_id: "obj1", name: "Name", type: "text", sort_order: 0 }])
      .mockResolvedValueOnce([{ id: "s1", object_id: "obj1", name: "New", sort_order: 0 }]);

    const { getPostgresFields, getPostgresStatuses } = await import("./object-metadata");
    await expect(getPostgresFields("obj1")).resolves.toHaveLength(1);
    await expect(getPostgresStatuses("obj1")).resolves.toHaveLength(1);

    expect(queryPg).toHaveBeenNthCalledWith(1, expect.stringContaining("from crm_fields"), ["obj1"]);
    expect(queryPg).toHaveBeenNthCalledWith(2, expect.stringContaining("from crm_statuses"), ["obj1"]);
  });

  it("resolves display field with expected fallback heuristic", async () => {
    const { resolvePostgresDisplayField } = await import("./object-metadata");

    expect(resolvePostgresDisplayField({ display_field: "Custom" }, [{ name: "Name", type: "text" }])).toBe("Custom");
    expect(resolvePostgresDisplayField({}, [{ name: "Opportunity Title", type: "text" }])).toBe("Opportunity Title");
    expect(resolvePostgresDisplayField({}, [{ name: "Summary", type: "text" }, { name: "Count", type: "number" }])).toBe("Summary");
    expect(resolvePostgresDisplayField({}, [{ name: "Count", type: "number" }])).toBe("Count");
    expect(resolvePostgresDisplayField({}, [])).toBe("id");
  });

  it("validates and updates display field", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "obj1", name: "people" }])
      .mockResolvedValueOnce([{ id: "f1", name: "Full Name" }])
      .mockResolvedValueOnce([]);

    const { updatePostgresDisplayField } = await import("./object-metadata");
    await expect(updatePostgresDisplayField("people", "Full Name")).resolves.toEqual({ ok: true, displayField: "Full Name" });
    expect(queryPg).toHaveBeenLastCalledWith(expect.stringContaining("update crm_objects"), ["Full Name", "obj1"]);
  });

  it("throws clear errors when object or field is missing during display update", async () => {
    queryPg.mockResolvedValueOnce([]);
    const { updatePostgresDisplayField } = await import("./object-metadata");
    await expect(updatePostgresDisplayField("missing", "Name")).rejects.toThrow("Object not found: missing");

    queryPg.mockReset();
    queryPg.mockResolvedValueOnce([{ id: "obj1", name: "people" }]).mockResolvedValueOnce([]);
    await expect(updatePostgresDisplayField("people", "Nope")).rejects.toThrow("Field not found on people: Nope");
  });

  it("reorders fields inside a postgres transaction", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "obj1", name: "people" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    withPgTransaction.mockImplementationOnce(async (fn) => fn({ query: txQuery }));

    const { reorderPostgresFields } = await import("./object-metadata");
    await expect(reorderPostgresFields("people", ["f2", "f1"])).resolves.toEqual({ ok: true });
    expect(withPgTransaction).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0]?.[0]).toContain("from crm_objects");
    expect(txQuery.mock.calls[1]?.[0]).toContain("update crm_fields");
    expect(txQuery.mock.calls[2]?.[1]).toEqual([1, "obj1", "f1"]);
  });

  it("creates objects inside a postgres transaction", async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [{ id: "obj_new", name: "deals" }] });
    withPgTransaction.mockImplementationOnce(async (fn) => fn({ query: txQuery }));

    const { createPostgresObject } = await import("./object-metadata");
    await expect(createPostgresObject({ id: "obj_new", name: "deals", parentPath: "crm" })).resolves.toEqual({
      ok: true,
      id: "obj_new",
      name: "deals",
      path: "crm/deals",
    });
    expect(withPgTransaction).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0]?.[0]).toContain("insert into crm_objects");
  });
});
