import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

const mockFieldRows = [
  { id: "f1", name: "Full Name", type: "text", canonical_column: "full_name", sort_order: 1 },
  { id: "f2", name: "Email", type: "email", canonical_column: "email", sort_order: 2 },
  { id: "f3", name: "Subscribed", type: "boolean", canonical_column: "subscribed", sort_order: 3 },
  { id: "f4", name: "Company", type: "relation", canonical_column: "company_id", related_object_id: "obj_company", related_object_name: "company", sort_order: 4 },
  { id: "f5", name: "Notes", type: "text", sort_order: 5 },
  { id: "f6", name: "Strength Score", type: "number", canonical_column: "strength_score", sort_order: 6 },
  { id: "f7", name: "Last Interaction", type: "date", canonical_column: "last_interaction_at", sort_order: 7 },
];

const mockOpportunityFieldRows = [
  { id: "of1", name: "Name", type: "text", canonical_column: "title", sort_order: 1 },
  { id: "of2", name: "Status", type: "text", canonical_column: "status", sort_order: 2 },
  { id: "of3", name: "Amount", type: "number", canonical_column: "price_amount", sort_order: 3 },
];

describe("postgres object read adapter", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
        const objectName = String(params?.[0] ?? "");
        if (objectName === "task") return [{ id: "obj_task", name: "task", default_view: "kanban" }];
        if (objectName === "work_task") return [{ id: "obj_work_task", name: "work_task", default_view: "kanban", display_field: "Title" }];
        if (objectName === "company") return [{ id: "obj_company", name: "company", display_field: "Name" }];
        if (objectName === "opportunity") return [{ id: "obj_opportunity", name: "opportunity", default_view: "table" }];
        return [{ id: "seed_obj_people_00000000000000", name: "people", default_view: "table" }];
      }
      if (sql.includes("from information_schema.columns")) {
        const table = params?.[0];
        if (table === "crm_companies") {
          return [
            { column_name: "id" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            { column_name: "name" },
            { column_name: "domain" },
            { column_name: "website" },
          ];
        }
        if (table === "crm_commercial_opportunities") {
          return [
            { column_name: "id" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            { column_name: "title" },
            { column_name: "status" },
            { column_name: "price_amount" },
          ];
        }
        if (table === "work_tasks") {
          return [
            { column_name: "id" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            { column_name: "title" },
            { column_name: "status" },
            { column_name: "project_id" },
            { column_name: "task_details" },
          ];
        }
        return [
          { column_name: "id" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
          { column_name: "full_name" },
          { column_name: "email" },
          { column_name: "subscribed" },
          { column_name: "company_id" },
        ];
      }
      if (sql.includes("count(*)::float") && sql.includes("_fill_rate")) {
        return [{
          _total: 10,
          id_fill_rate: 1,
          created_at_fill_rate: 1,
          updated_at_fill_rate: 1,
          full_name_fill_rate: 0.8,
          email_fill_rate: 0.9,
          subscribed_fill_rate: 0.3,
          company_id_fill_rate: 0.5,
          name_fill_rate: 0.7,
          domain_fill_rate: 0.4,
          website_fill_rate: 0.2,
        }];
      }
      if (sql.includes("from crm_fields") && sql.includes("left join crm_objects")) {
        if (params?.[0] === "obj_opportunity") {
          return mockOpportunityFieldRows;
        }
        if (params?.[0] === "obj_work_task") {
          return [
            { id: "wt_title", name: "Title", type: "text", canonical_column: "title", sort_order: 1 },
            { id: "wt_status", name: "Status", type: "enum", canonical_column: "status", sort_order: 2 },
            { id: "wt_project", name: "Project", type: "relation", canonical_column: "project_id", related_object_id: "reb_project_object", related_object_name: "project", relationship_type: "many_to_one", sort_order: 3 },
            { id: "wt_details", name: "Task Details", type: "richtext", canonical_column: "task_details", sort_order: 4 },
          ];
        }
        return mockFieldRows;
      }
      if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
        if (params?.[0] === "obj_opportunity") {
          return mockOpportunityFieldRows;
        }
        return mockFieldRows;
      }
      if (sql.includes("count(*)")) return [{ count: "1" }];
      if (sql.includes("from crm_people")) return [{ entry_id: "p1", created_at: "2026-01-01", updated_at: "2026-01-01", "Full Name": "Ada", Email: "ada@example.com", Company: "c1" }];
      if (sql.includes("from crm_commercial_opportunities")) return [{ entry_id: "o1", created_at: "2026-01-01", updated_at: "2026-01-01", Name: "Retired EV packs", Status: "open", Amount: 125000 }];
      if (sql.includes("from work_tasks")) return [{ entry_id: "t1", created_at: "2026-01-01", updated_at: "2026-01-01", Title: "Finalize API", Preview: "Objective: finish the API", Status: "Done", Project: "p1" }];
      if (sql.includes("from projects")) return [
        { id: "p2", name: "Safe change delivery" },
        { id: "p1", name: "Supplier inventory lifecycle" },
      ];
      if (sql.includes("from crm_companies")) return [{ id: "c1", name: "Acme", domain: "acme.test", website: null }];
      return [];
    });
  });

  it("returns existing object API shape", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost?pagesize=10"));

    expect(data.object.name).toBe("people");
    expect(data.fields[0].name).toBe("Email");
    expect(data.entries[0].entry_id).toBe("p1");
    expect(data.savedViews).toEqual([]);
    expect(data.activeView).toBeUndefined();
    expect(data.statuses).toEqual([]);
  });

  it("removes stale fields whose canonical_column does not exist on the backing table", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost"));

    const names = data.fields.map((field) => field.name);
    expect(names).not.toContain("Strength Score");
    expect(names).not.toContain("Last Interaction");
    expect(names).toContain("Full Name");
    expect(names).toContain("Email");
    expect(names).toContain("Notes");
  });

  it("orders people/company fields by backing table fill rate", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost"));

    expect(data.fields.map((field) => field.name)).toEqual([
      "Email",      // 0.9 fill rate
      "Full Name",  // 0.8
      "Company",    // 0.5
      "Subscribed", // 0.3
      "Notes",      // no canonical column; stable sort_order fallback
    ]);
  });

  it("does not reorder objects outside the people/company scope", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("task", new URL("http://localhost"));

    expect(data.fields.map((field) => field.name)).toEqual([
      "Full Name",
      "Email",
      "Subscribed",
      "Company",
      "Notes",
      "Strength Score",
      "Last Interaction",
    ]);
  });

  it("applies search, filters, and canonical sort to list and count queries", async () => {
    const filters = Buffer.from(JSON.stringify({
      id: "root",
      conjunction: "and",
      rules: [
        { id: "r1", field: "Subscribed", operator: "is_true" },
        { id: "r2", field: "Notes", operator: "contains", value: "VIP" },
      ],
    })).toString("base64");
    const sort = encodeURIComponent(JSON.stringify([{ field: "Full Name", direction: "asc" }]));

    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL(`http://localhost?search=ada&filters=${filters}&sort=${sort}`));

    const countCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select count(*) from crm_people"));
    const listCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_people"));
    expect(countCall?.[0]).toContain("lower");
    expect(countCall?.[1]).toContain("%ada%");
    expect(listCall?.[0]).toContain('order by e."full_name" asc');
    expect(data.totalCount).toBe(1);
  });

  it("adds relation metadata, labels, and favicons for company relations", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost"));

    expect(data.fields.find((field) => field.name === "Company")?.related_object_name).toBe("company");
    expect(data.relationLabels.Company.c1).toBe("Acme");
    expect(data.relationFaviconUrls.Company.c1).toContain("google.com/s2/favicons");
  });

  it("does not 500 when canonical_column is absent from the backing table", async () => {
    const { getPostgresObjectData } = await import("./object-read");

    // This is the exact failing scenario: `crm_fields` maps display fields to
    // `strength_score` / `last_interaction_at`, but the actual `crm_companies`
    // table does not have those columns.
    const data = await getPostgresObjectData("company", new URL("http://localhost?pageSize=5"));

    expect(data.object.name).toBe("company");
    expect(data.entries).toHaveLength(1);
  });

  it("omits missing canonical columns from the select list and order by", async () => {
    const sort = encodeURIComponent(JSON.stringify([
      { field: "Full Name", direction: "asc" },
      { field: "Last Interaction", direction: "desc" },
    ]));

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL(`http://localhost?sort=${sort}`));

    const listCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_people"));
    const listSql = String(listCall?.[0]);
    expect(listSql).not.toContain('"strength_score"');
    expect(listSql).not.toContain('"last_interaction_at"');
    expect(listSql).toContain('order by e."full_name" asc');
    expect(listSql).toContain("e.created_at desc");
    expect(listSql).toContain("e.id desc");
  });

  it("ignores filters that reference missing canonical columns", async () => {
    const filters = Buffer.from(JSON.stringify({
      id: "root",
      conjunction: "and",
      rules: [
        { id: "r1", field: "Subscribed", operator: "is_true" },
        { id: "r2", field: "Strength Score", operator: "is_not_empty" },
      ],
    })).toString("base64");

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL(`http://localhost?filters=${filters}`));

    const countCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("select count(*)"));
    const countSql = String(countCall?.[0]);
    expect(countSql).toContain("subscribed");
    expect(countSql).not.toContain('"strength_score"');
  });

  it("introspects the actual table and preserves real canonical columns", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL("http://localhost"));

    const infoSchemaCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("from information_schema.columns"));
    expect(infoSchemaCall?.[1]).toEqual(["crm_people"]);

    const listCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_people"));
    const listSql = String(listCall?.[0]);
    expect(listSql).toContain('"full_name" as "Full Name"');
    expect(listSql).toContain('"email" as "Email"');
  });

  it("loads opportunity entries from crm_commercial_opportunities", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("opportunity", new URL("http://localhost?pageSize=10"));

    expect(data.object.name).toBe("opportunity");
    expect(data.entries).toHaveLength(1);

    const listCall = queryPg.mock.calls.find(([sql]) =>
      String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_commercial_opportunities"),
    );
    expect(String(listCall?.[0])).toContain('"title"');
  });

  it("loads work tasks for Kanban and resolves the Project relation label", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("work_task", new URL("http://localhost?pageSize=10"));

    expect(data.object.default_view).toBe("kanban");
    expect(data.fields.find((field) => field.name === "Status")?.type).toBe("enum");
    expect(data.fields.map((field) => field.name)).toContain("Preview");
    expect(data.fields.map((field) => field.name)).not.toContain("Task Details");
    expect(data.entries[0]).toMatchObject({ Title: "Finalize API", Preview: "Objective: finish the API", Status: "Done", Project: "p1" });
    expect(data.entries[0]).not.toHaveProperty("Task Details");
    const taskListCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from work_tasks"));
    expect(String(taskListCall?.[0])).toContain("regexp_replace");
    expect(String(taskListCall?.[0])).toContain('as "Preview"');
    expect(String(taskListCall?.[0])).not.toContain('as "Task Details"');
    expect(data.relationLabels.Project).toEqual({
      p2: "Safe change delivery",
      p1: "Supplier inventory lifecycle",
    });
    const projectOptionsCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("from projects"));
    expect(projectOptionsCall?.[0]).toContain("where status = 'Active'");
    expect(projectOptionsCall?.[0]).toContain("order by name");
    expect(projectOptionsCall?.[1]).toBeUndefined();
  });
});
