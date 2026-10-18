import { describe, it, expect, vi, beforeEach } from "vitest";

const {txQuery} = vi.hoisted(() => ({txQuery:vi.fn(async () => ({rows:[{id:1}]}))}));
vi.mock("@/lib/postgres", () => ({
  queryPg: vi.fn(async () => []),
  withPgTransaction: async (fn: (client: {query: typeof txQuery}) => unknown) => fn({query:txQuery}),
}));

describe("crm-postgres sql execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non read-only SQL", async () => {
    const { postgresReadOnlyQuery } = await import("./sql-execution");
    await expect(postgresReadOnlyQuery("DELETE FROM crm_people")).rejects.toThrow(
      "Only read-only queries are allowed",
    );
  });

  it("rejects raw reads from user-scoped tables", async () => {
    const { postgresReadOnlyQuery } = await import("./sql-execution");
    await expect(
      postgresReadOnlyQuery("SELECT * FROM work_tasks"),
    ).rejects.toThrow("Raw SQL access to user-scoped CRM data is disabled");
    await expect(
      postgresReadOnlyQuery(
        "WITH x AS (SELECT * FROM crm_interactions) SELECT * FROM x",
      ),
    ).rejects.toThrow("Raw SQL access to user-scoped CRM data is disabled");
    await expect(
      postgresReadOnlyQuery("SELECT * FROM crm_interactions"),
    ).rejects.toThrow("Raw SQL access to user-scoped CRM data is disabled");
    await expect(
      postgresReadOnlyQuery("SELECT * FROM crm_relation_links"),
    ).rejects.toThrow("Raw SQL access to user-scoped CRM data is disabled");
  });

  it("denies web raw mail reads and every generic mail mutation", async () => {
    const { postgresReadOnlyQuery } = await import("./sql-execution");
    const { queryPg } = await import("@/lib/postgres");
    vi.mocked(queryPg).mockResolvedValue([]);
    for (const table of ["mail_message","mail_thread","mail_event","mail_approval"]) await expect(postgresReadOnlyQuery(`select * from ${table}`)).rejects.toThrow("user-scoped");
    for (const sql of [
      "update mail_message set state = 'accepted'",
      "update mail_message set delivered_at = now()",
      "insert into mail_approval (id) values ('fake')",
      "delete from mail_event",
      "update mail_identity set active = true",
      "with x as (delete from mail_approval returning *) select * from x",
      "select 1; update mail_message set state = 'accepted'",
    ]) await expect(postgresReadOnlyQuery(sql)).rejects.toThrow("Only read-only");
    expect(queryPg).not.toHaveBeenCalled();
  });

  it("passes read-only SQL to postgres", async () => {
    const { queryPg } = await import("@/lib/postgres");
    const { postgresReadOnlyQuery } = await import("./sql-execution");

    const rows = await postgresReadOnlyQuery("SELECT 1 as id");
    expect(txQuery).toHaveBeenCalledWith("set local role crm_web_sql");
    expect(txQuery).toHaveBeenCalledWith("SELECT 1 as id");
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
