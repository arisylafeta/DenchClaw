import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());
const withPgTransaction = vi.hoisted(() => vi.fn(async (fn) => fn({ query: queryPg })));
vi.mock("../postgres", () => ({ queryPg, withPgTransaction }));

describe("postgres saved views", () => {
  beforeEach(() => {
    queryPg.mockReset();
    withPgTransaction.mockClear();
  });

  it("returns empty views and no active view (no-op after crm_saved_views was dropped)", async () => {
    const { getPostgresObjectViews } = await import("./views");
    const result = await getPostgresObjectViews("people");

    expect(result.views).toEqual([]);
    expect(result.activeView).toBeUndefined();
    expect(result.viewSettings).toBeUndefined();
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("save is a no-op that succeeds without touching postgres (after crm_saved_views was dropped)", async () => {
    const { savePostgresObjectViews } = await import("./views");
    const ok = await savePostgresObjectViews(
      "people",
      [{ name: "All", view_type: "table", columns: ["Full Name"] }],
      "All",
      { column_widths: {} },
    );

    expect(ok).toBe(true);
    expect(queryPg).not.toHaveBeenCalled();
    expect(withPgTransaction).not.toHaveBeenCalled();
  });
});
