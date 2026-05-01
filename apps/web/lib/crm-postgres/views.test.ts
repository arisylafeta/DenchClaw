import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());
const withPgTransaction = vi.hoisted(() => vi.fn(async (fn) => fn({ query: queryPg })));
vi.mock("../postgres", () => ({ queryPg, withPgTransaction }));

describe("postgres saved views", () => {
  beforeEach(() => {
    queryPg.mockReset();
    withPgTransaction.mockClear();
  });

  it("loads saved views and active view", async () => {
    queryPg.mockResolvedValueOnce([{ id: "obj1" }]);
    queryPg.mockResolvedValueOnce([{ name: "All", view_type: "table", filters: null, sort: [], columns: ["Full Name"], settings: null }]);
    queryPg.mockResolvedValueOnce([{ active_view_name: "All", settings: { column_widths: {} } }]);

    const { getPostgresObjectViews } = await import("./views");
    const result = await getPostgresObjectViews("people");

    expect(result.views[0].name).toBe("All");
    expect(result.activeView).toBe("All");
  });

  it("replaces saved views and stores the active view by matching name", async () => {
    queryPg.mockResolvedValueOnce([{ id: "obj1" }]);
    queryPg.mockResolvedValueOnce([]);
    queryPg.mockResolvedValueOnce([{ id: "view-all" }]);
    queryPg.mockResolvedValueOnce([]);

    const { savePostgresObjectViews } = await import("./views");
    const ok = await savePostgresObjectViews(
      "people",
      [{ name: "All", view_type: "table", columns: ["Full Name"] }],
      "All",
      { column_widths: {} },
    );

    expect(ok).toBe(true);
    expect(queryPg).toHaveBeenCalledWith(
      expect.stringContaining("delete from crm_saved_views"),
      ["obj1"],
    );
    expect(queryPg).toHaveBeenLastCalledWith(
      expect.stringContaining("insert into crm_object_view_settings"),
      ["obj1", "view-all", { column_widths: {} }],
    );
  });

  it("saves views inside a transaction", async () => {
    queryPg.mockResolvedValueOnce([{ id: "obj1" }]);
    queryPg.mockResolvedValueOnce([]);
    queryPg.mockResolvedValueOnce([{ id: "view-all" }]);
    queryPg.mockResolvedValueOnce([]);

    const { savePostgresObjectViews } = await import("./views");
    await savePostgresObjectViews("people", [{ name: "All", view_type: "table" }], "All");

    expect(withPgTransaction).toHaveBeenCalledTimes(1);
  });
});
