import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

const mockFieldRows = [
  {
    id: "f1",
    name: "Full Name",
    type: "text",
    canonical_column: "full_name",
    sort_order: 1,
  },
  {
    id: "f2",
    name: "Email",
    type: "email",
    canonical_column: "email",
    sort_order: 2,
  },
  {
    id: "f3",
    name: "Subscribed",
    type: "boolean",
    canonical_column: "subscribed",
    sort_order: 3,
  },
  {
    id: "f4",
    name: "Company",
    type: "relation",
    canonical_column: "company_id",
    related_object_id: "obj_company",
    related_object_name: "company",
    sort_order: 4,
  },
  { id: "f5", name: "Notes", type: "text", sort_order: 5 },
  {
    id: "f6",
    name: "Strength Score",
    type: "number",
    canonical_column: "strength_score",
    sort_order: 6,
  },
  {
    id: "f7",
    name: "Last Interaction",
    type: "date",
    canonical_column: "last_interaction_at",
    sort_order: 7,
  },
];

const mockOpportunityFieldRows = [
  {
    id: "of1",
    name: "Name",
    type: "text",
    canonical_column: "title",
    sort_order: 1,
  },
  {
    id: "of2",
    name: "Status",
    type: "text",
    canonical_column: "status",
    sort_order: 2,
  },
  {
    id: "of3",
    name: "Amount",
    type: "number",
    canonical_column: "price_amount",
    sort_order: 3,
  },
];

describe("postgres object read adapter", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("left join crm_object_views")) return [];
      if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
        const objectName = String(params?.[0] ?? "");
        if (objectName === "task")
          return [{ id: "obj_task", name: "task", default_view: "kanban" }];
        if (objectName === "work_task")
          return [
            {
              id: "obj_work_task",
              name: "work_task",
              default_view: "kanban",
              display_field: "Title",
            },
          ];
        if (objectName === "interaction")
          return [
            {
              id: "obj_interaction",
              name: "interaction",
              default_view: "table",
            },
          ];
        if (objectName === "company")
          return [
            { id: "obj_company", name: "company", display_field: "Name" },
          ];
        if (objectName === "opportunity")
          return [
            {
              id: "obj_opportunity",
              name: "opportunity",
              default_view: "table",
            },
          ];
        if (objectName === "bulk_trade")
          return [
            {
              id: "obj_bulk_trade",
              name: "bulk_trade",
              entity_table: "crm_bulk_trade_overview",
              default_view: "table",
              display_field: "Title",
            },
          ];
        if (objectName === "unsafe_object")
          return [
            {
              id: "obj_unsafe",
              name: "unsafe_object",
              entity_table: "crm_people; drop table crm_people",
            },
          ];
        return [
          {
            id: "seed_obj_people_00000000000000",
            name: "people",
            default_view: "table",
          },
        ];
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
        if (table === "crm_bulk_trade_overview") {
          return [
            { column_name: "id" },
            { column_name: "title" },
            { column_name: "summary" },
          ];
        }
        if (table === "crm_interactions") {
          return [
            { column_name: "id" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            { column_name: "type" },
            { column_name: "email_message_id" },
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
            { column_name: "assignee_id" },
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
        return [
          {
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
          },
        ];
      }
      if (
        sql.includes("from crm_fields") &&
        sql.includes("left join crm_objects")
      ) {
        if (params?.[0] === "obj_interaction") {
          return [
            {
              id: "int_type",
              name: "Type",
              type: "text",
              canonical_column: "type",
              sort_order: 1,
            },
            {
              id: "int_email",
              name: "Email",
              type: "relation",
              canonical_column: "email_message_id",
              related_object_name: "email_message",
              sort_order: 2,
            },
          ];
        }
        if (params?.[0] === "obj_opportunity") {
          return mockOpportunityFieldRows;
        }
        if (params?.[0] === "obj_bulk_trade") {
          return [
            { id: "bt_title", name: "Title", type: "text", canonical_column: "title", sort_order: 0 },
            { id: "bt_summary", name: "Summary", type: "richtext", canonical_column: "summary", sort_order: 1 },
          ];
        }
        if (params?.[0] === "obj_work_task") {
          return [
            {
              id: "wt_title",
              name: "Title",
              type: "text",
              canonical_column: "title",
              sort_order: 1,
            },
            {
              id: "wt_status",
              name: "Status",
              type: "enum",
              canonical_column: "status",
              sort_order: 2,
            },
            {
              id: "wt_project",
              name: "Project",
              type: "relation",
              canonical_column: "project_id",
              related_object_id: "reb_project_object",
              related_object_name: "project",
              relationship_type: "many_to_one",
              sort_order: 3,
            },
            {
              id: "wt_assignee",
              name: "Assignee",
              type: "relation",
              canonical_column: "assignee_id",
              related_object_id: "crm_users_object",
              related_object_name: "crm_user",
              relationship_type: "many_to_one",
              sort_order: 4,
            },
            {
              id: "wt_details",
              name: "Task Details",
              type: "richtext",
              canonical_column: "task_details",
              sort_order: 5,
            },
          ];
        }
        return mockFieldRows;
      }
      if (
        sql.includes("from crm_fields") &&
        sql.includes("where object_id = $1")
      ) {
        if (params?.[0] === "obj_opportunity") {
          return mockOpportunityFieldRows;
        }
        return mockFieldRows;
      }
      if (sql.includes("count(*)")) return [{ count: "1" }];
      if (sql.includes("from crm_bulk_trade_overview"))
        return [{ id: "lot-1", title: "Battery lot", summary: "Observed supply" }];
      if (sql.includes("from crm_people e"))
        return [
          {
            entry_id: "p1",
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
            "Full Name": "Ada",
            Email: "ada@example.com",
            Company: "c1",
          },
        ];
      if (sql.includes("from crm_commercial_opportunities"))
        return [
          {
            entry_id: "o1",
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
            Name: "Retired EV packs",
            Status: "open",
            Amount: 125000,
          },
        ];
      if (sql.includes("from work_tasks"))
        return [
          {
            entry_id: "t1",
            created_at: "2026-01-01",
            updated_at: "2026-01-01",
            Title: "Finalize API",
            Preview: "Objective: finish the API",
            Status: "Done",
            Project: "p1",
            Assignee: "11111111-1111-4111-8111-111111111111",
          },
        ];
      if (sql.includes("from projects"))
        return [
          { id: "p2", name: "Safe change delivery" },
          { id: "p1", name: "Supplier inventory lifecycle" },
        ];
      if (sql.includes("from crm_companies"))
        return [{ id: "c1", name: "Acme", domain: "acme.test", website: null }];
      if (sql.includes("from crm_users"))
        return [
          { id: "11111111-1111-4111-8111-111111111111", email: "ari@rebattery.io" },
        ];
      return [];
    });
  });

  it("returns existing object API shape", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData(
      "people",
      new URL("http://localhost?pagesize=10"),
    );

    expect(data.object.name).toBe("people");
    expect(data.fields[0].name).toBe("Email");
    expect(data.entries[0].entry_id).toBe("p1");
    expect(data.savedViews).toEqual([]);
    expect(data.activeView).toBeUndefined();
    expect(data.statuses).toEqual([]);
  });

  it("reads a registered entity table without adding a core object switch", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData(
      "bulk_trade",
      new URL("http://localhost"),
    );

    expect(data.entries).toEqual([
      { id: "lot-1", title: "Battery lot", summary: "Observed supply" },
    ]);
    expect(queryPg).toHaveBeenCalledWith(
      expect.stringContaining("from crm_bulk_trade_overview e"),
      expect.any(Array),
    );
  });

  it("rejects unsafe registered entity table names", async () => {
    const { getPostgresObjectData } = await import("./object-read");

    await expect(
      getPostgresObjectData("unsafe_object", new URL("http://localhost")),
    ).rejects.toThrow("Invalid registered entity table");
  });

  it("removes stale fields whose canonical_column does not exist on the backing table", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData(
      "people",
      new URL("http://localhost"),
    );

    const names = data.fields.map((field) => field.name);
    expect(names).not.toContain("Strength Score");
    expect(names).not.toContain("Last Interaction");
    expect(names).toContain("Full Name");
    expect(names).toContain("Email");
    expect(names).toContain("Notes");
  });



  it("adds relation metadata, labels, and favicons for company relations", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData(
      "people",
      new URL("http://localhost"),
    );

    expect(
      data.fields.find((field) => field.name === "Company")
        ?.related_object_name,
    ).toBe("company");
    expect(data.relationLabels.Company.c1).toBe("Acme");
    expect(data.relationFaviconUrls.Company.c1).toContain(
      "google.com/s2/favicons",
    );
  });


  it("ignores filters that reference missing canonical columns", async () => {
    const filters = Buffer.from(
      JSON.stringify({
        id: "root",
        conjunction: "and",
        rules: [
          { id: "r1", field: "Subscribed", operator: "is_true" },
          { id: "r2", field: "Strength Score", operator: "is_not_empty" },
        ],
      }),
    ).toString("base64");

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData(
      "people",
      new URL(`http://localhost?filters=${filters}`),
    );

    const countCall = queryPg.mock.calls.find(([sql]) =>
      String(sql).includes("select count(*)"),
    );
    const countSql = String(countCall?.[0]);
    expect(countSql).toContain("subscribed");
    expect(countSql).not.toContain('"strength_score"');
  });


  it("loads opportunity entries from crm_commercial_opportunities", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData(
      "opportunity",
      new URL("http://localhost?pageSize=10"),
    );

    expect(data.object.name).toBe("opportunity");
    expect(data.entries).toHaveLength(1);

  });


  it("matches multi-value fields (text[] columns such as tags) on any of the chosen values", async () => {
    const base = queryPg.getMockImplementation()!;
    queryPg.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from information_schema.columns") && params?.[0] !== "crm_companies") {
        return [...(await base(sql, params)), { column_name: "tags" }];
      }
      if (sql.includes("from crm_fields") && sql.includes("object_id = $1")) {
        return [...(await base(sql, params)), { id: "f_tags", name: "Tags", type: "select", canonical_column: "tags", enum_multiple: true, sort_order: 9 }];
      }
      return base(sql, params);
    });
    const encode = (operator: string) => Buffer.from(JSON.stringify({
      id: "root", conjunction: "and", rules: [{ id: "tag-rule", field: "Tags", operator, value: ["buyer", "ess-2026"] }],
    })).toString("base64");

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL(`http://localhost?filters=${encodeURIComponent(encode("is_any_of"))}`));
    const anyCall = queryPg.mock.calls.findLast(([sql]) => String(sql).includes("select count(*)"));
    expect(String(anyCall?.[0])).toContain('e."tags" && $2::text[]');
    expect(anyCall?.[1]).toContainEqual(["buyer", "ess-2026"]);

    await getPostgresObjectData("people", new URL(`http://localhost?filters=${encodeURIComponent(encode("is_none_of"))}`));
    const noneCall = queryPg.mock.calls.findLast(([sql]) => String(sql).includes("select count(*)"));
    expect(String(noneCall?.[0])).toContain('(e."tags" is null or not (e."tags" && $2::text[]))');
  });

  it("keeps unset enum values in negative enum filters", async () => {
    const filters = Buffer.from(
      JSON.stringify({
        id: "root",
        conjunction: "and",
        rules: [
          {
            id: "status-rule",
            field: "Status",
            operator: "is_not",
            value: "Done",
          },
        ],
      }),
    ).toString("base64");

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData(
      "work_task",
      new URL(`http://localhost?filters=${encodeURIComponent(filters)}`),
    );

    const countCall = queryPg.mock.calls.find(
      ([sql]) =>
        String(sql).includes("select count(*)") &&
        String(sql).includes("from work_tasks"),
    );
    expect(String(countCall?.[0])).toContain(
      '(e."status" is null or lower(e."status"::text) <> lower($3))',
    );
  });

  it("scopes email-linked interactions to the authenticated mailbox", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData(
      "interaction",
      new URL("http://localhost"),
      "11111111-1111-4111-8111-111111111111",
    );

    const countCall = queryPg.mock.calls.find(
      ([sql]) =>
        String(sql).includes("select count(*)") &&
        String(sql).includes("from crm_interactions"),
    );
    expect(String(countCall?.[0])).toContain(
      "e.email_message_id is null or exists",
    );
    expect(String(countCall?.[0])).toContain(
      "scoped_message.mailbox_owner_id = $2::uuid",
    );
    expect(countCall?.[1]).toEqual([
      "obj_interaction",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("treats unset booleans as false", async () => {
    const filters = Buffer.from(
      JSON.stringify({
        id: "root",
        conjunction: "and",
        rules: [
          { id: "subscribed-rule", field: "Subscribed", operator: "is_false" },
        ],
      }),
    ).toString("base64");

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData(
      "people",
      new URL(`http://localhost?filters=${encodeURIComponent(filters)}`),
    );

    const countCall = queryPg.mock.calls.find(
      ([sql]) =>
        String(sql).includes("select count(*)") &&
        String(sql).includes("from crm_people"),
    );
    expect(String(countCall?.[0])).toContain('(e."subscribed") is not true');
  });
});
