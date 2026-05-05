import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/postgres", () => ({
  queryPg: vi.fn(async () => []),
}));

describe("crm-postgres sql execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects non read-only SQL", async () => {
    const { postgresReadOnlyQuery } = await import("./sql-execution");
    await expect(postgresReadOnlyQuery("DELETE FROM crm_people")).rejects.toThrow(
      "Only read-only queries are allowed",
    );
  });

  it("passes read-only SQL to postgres", async () => {
    const { queryPg } = await import("@/lib/postgres");
    vi.mocked(queryPg).mockResolvedValueOnce([{ id: 1 }]);
    const { postgresReadOnlyQuery } = await import("./sql-execution");

    const rows = await postgresReadOnlyQuery("SELECT 1 as id");
    expect(queryPg).toHaveBeenCalledWith("SELECT 1 as id");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("groups information schema columns by table", async () => {
    const { queryPg } = await import("@/lib/postgres");
    vi.mocked(queryPg).mockResolvedValueOnce([
      { table_name: "crm_people", column_name: "id", data_type: "text", is_nullable: "NO" },
      { table_name: "crm_people", column_name: "name", data_type: "text", is_nullable: "YES" },
      { table_name: "crm_companies", column_name: "id", data_type: "text", is_nullable: "NO" },
    ]);
    const { introspectPostgresCrm } = await import("./sql-execution");

    const tables = await introspectPostgresCrm();
    expect(tables).toHaveLength(2);
    expect(tables[0]).toMatchObject({ table_name: "crm_people", column_count: 2 });
    expect(tables[1]).toMatchObject({ table_name: "crm_companies", column_count: 1 });
  });
});
