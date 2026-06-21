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

  it("loads fields ordered by sort_order and returns empty statuses (crm_statuses dropped)", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "f1", object_id: "obj1", name: "Name", type: "text", sort_order: 0 }]);

    const { getPostgresFields, getPostgresStatuses } = await import("./object-metadata");
    await expect(getPostgresFields("obj1")).resolves.toHaveLength(1);
    await expect(getPostgresStatuses("obj1")).resolves.toEqual([]);

    expect(queryPg).toHaveBeenCalledWith(expect.stringContaining("from crm_fields"), ["obj1"]);
    expect(queryPg).not.toHaveBeenCalledWith(expect.stringContaining("from crm_statuses"), expect.anything());
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
      .mockResolvedValueOnce({ rows: [{ id: "f2" }, { id: "f1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    withPgTransaction.mockImplementationOnce(async (fn) => fn({ query: txQuery }));

    const { reorderPostgresFields } = await import("./object-metadata");
    await expect(reorderPostgresFields("people", ["f2", "f1"])).resolves.toEqual({ ok: true });
    expect(withPgTransaction).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0]?.[0]).toContain("from crm_objects");
    expect(txQuery.mock.calls[1]?.[0]).toContain("from crm_fields");
    expect(txQuery.mock.calls[2]?.[0]).toContain("update crm_fields");
    expect(txQuery.mock.calls[3]?.[1]).toEqual([1, "obj1", "f1"]);
  });

  it("rejects reorder when any field id is missing for object and issues no updates", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "obj1", name: "people" }] })
      .mockResolvedValueOnce({ rows: [{ id: "f1" }] });
    withPgTransaction.mockImplementationOnce(async (fn) => fn({ query: txQuery }));

    const { reorderPostgresFields } = await import("./object-metadata");
    await expect(reorderPostgresFields("people", ["f1", "foreign_f2"]))
      .rejects.toThrow("Fields not found on people: foreign_f2");

    expect(withPgTransaction).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[1]?.[0]).toContain("from crm_fields");
    expect(txQuery.mock.calls.some(([sql]) => String(sql).includes("update crm_fields"))).toBe(false);
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

  it("creates a field for a postgres object", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "obj1", name: "people" }])
      .mockResolvedValueOnce([{ cnt: 0 }])
      .mockResolvedValueOnce([{ max_order: 2 }])
      .mockResolvedValueOnce([{ id: "field1", name: "Stage", type: "enum" }]);

    const { createPostgresField } = await import("./object-metadata");
    await expect(createPostgresField("people", { name: "Stage", type: "enum", enum_values: ["Lead"] }))
      .resolves.toEqual({ ok: true, fieldId: "field1", name: "Stage", type: "enum" });
    expect(queryPg).toHaveBeenLastCalledWith(expect.stringContaining("insert into crm_fields"), expect.any(Array));
  });

  it("updates a postgres field", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "obj1", name: "people" }])
      .mockResolvedValueOnce([{ id: "field1", object_id: "obj1", type: "enum" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "field1", name: "Status" }]);

    const { updatePostgresField } = await import("./object-metadata");
    await expect(updatePostgresField("people", "field1", { name: "Status" })).resolves.toEqual({ ok: true });
    expect(queryPg).toHaveBeenNthCalledWith(4, expect.stringContaining("update crm_fields"), ["Status", "field1", "obj1"]);
  });

  it("deletes a postgres field and its custom values", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "obj1", name: "people" }])
      .mockResolvedValueOnce([{ id: "field1", object_id: "obj1" }])
      .mockResolvedValueOnce([]);

    const { deletePostgresField } = await import("./object-metadata");
    await expect(deletePostgresField("people", "field1")).resolves.toEqual({ ok: true });
    expect(queryPg).toHaveBeenNthCalledWith(3, expect.stringContaining("delete from crm_fields"), ["field1", "obj1"]);
  });

  it("renames enum values and updates existing values", async () => {
    queryPg
      .mockResolvedValueOnce([{ id: "obj1", name: "people" }])
      .mockResolvedValueOnce([{ id: "field1", object_id: "obj1", enum_values: ["Lead", "Customer"] }])
      .mockResolvedValueOnce([]);

    const { renamePostgresEnumValue } = await import("./object-metadata");
    await expect(renamePostgresEnumValue("people", "field1", "Lead", "Prospect"))
      .resolves.toEqual({ ok: true, updated: true });
    expect(queryPg).toHaveBeenNthCalledWith(3, expect.stringContaining("update crm_fields"), [JSON.stringify(["Prospect", "Customer"]), "field1", "obj1"]);
  });
});
