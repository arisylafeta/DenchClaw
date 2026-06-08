import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

describe("postgres object read adapter", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
        if (queryPg.mock.calls.at(-1)?.[1]?.[0] === "task") return [{ id: "obj_task", name: "task", default_view: "kanban" }];
        if (sql.includes("company")) return [{ id: "obj_company", name: "company", display_field: "Name" }];
        return [{ id: "seed_obj_people_00000000000000", name: "people", default_view: "table" }];
      }
      if (sql.includes("from crm_fields") && sql.includes("left join crm_objects")) {
        return [
          { id: "f1", name: "Full Name", type: "text", canonical_column: "full_name", sort_order: 1 },
          { id: "f2", name: "Email", type: "email", canonical_column: "email", sort_order: 2 },
          { id: "f3", name: "Subscribed", type: "boolean", canonical_column: "subscribed", sort_order: 3 },
          { id: "f4", name: "Company", type: "relation", canonical_column: "company_id", related_object_id: "obj_company", related_object_name: "company", sort_order: 4 },
          { id: "f5", name: "Notes", type: "text", sort_order: 5 },
        ];
      }
      if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
        return [
          { id: "f1", name: "Full Name", type: "text", canonical_column: "full_name", sort_order: 1 },
          { id: "f2", name: "Email", type: "email", canonical_column: "email", sort_order: 2 },
          { id: "f3", name: "Subscribed", type: "boolean", canonical_column: "subscribed", sort_order: 3 },
          { id: "f4", name: "Company", type: "relation", canonical_column: "company_id", related_object_id: "obj_company", sort_order: 4 },
          { id: "f5", name: "Notes", type: "text", sort_order: 5 },
        ];
      }
      if (sql.includes("from crm_saved_views")) return [{ id: "v1", name: "All CRM Contacts", view_type: "table", columns: ["Full Name"] }];
      if (sql.includes("select count(distinct cfv.entry_id)")) return [{ count: "1" }];
      if (sql.includes("select distinct cfv.entry_id") && sql.includes("from crm_custom_field_values cfv")) return [{ entry_id: "t1", created_at: null, updated_at: null }];
      if (sql.includes("count(*)")) return [{ count: "1" }];
      if (sql.includes("from crm_people")) return [{ entry_id: "p1", created_at: "2026-01-01", updated_at: "2026-01-01", "Full Name": "Ada", Email: "ada@example.com", Company: "c1" }];
      if (sql.includes("from crm_custom_field_values")) return [
        { entry_id: "p1", field_name: "Notes", text_value: "VIP" },
        { entry_id: "t1", field_name: "Title", text_value: "Prepare investor deck" },
        { entry_id: "t1", field_name: "Status", text_value: "In Queue" },
      ];
      if (sql.includes("from crm_companies")) return [{ id: "c1", name: "Acme", domain: "acme.test", website: null }];
      return [];
    });
  });

  it("returns existing object API shape", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost?pagesize=10"));

    expect(data.object.name).toBe("people");
    expect(data.fields[0].name).toBe("Full Name");
    expect(data.entries[0].entry_id).toBe("p1");
    expect(data.savedViews?.[0].name).toBe("All CRM Contacts");
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

    const countCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("select count(*)"));
    const listCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_people"));
    expect(countCall?.[0]).toContain("lower");
    expect(countCall?.[0]).toContain("from crm_custom_field_values");
    expect(countCall?.[1]).toContain("%ada%");
    expect(countCall?.[1]).toContain("%VIP%");
    expect(listCall?.[0]).toContain('order by e."full_name" asc');
    expect(data.totalCount).toBe(1);
  });

  it("sorts list queries by custom field values with parameterized field ids", async () => {
    const sort = encodeURIComponent(JSON.stringify([{ field: "Notes", direction: "asc" }]));

    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL(`http://localhost?sort=${sort}`));

    const listCall = queryPg.mock.calls.find(([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_people"));
    const sql = String(listCall?.[0]);

    expect(sql).toContain("order by (select coalesce(cfv.text_value, cfv.number_value::text, cfv.boolean_value::text, cfv.date_value::text, cfv.json_value::text)");
    expect(sql).toContain("from crm_custom_field_values cfv");
    expect(sql).toContain("cfv.object_id = $1 and cfv.field_id = $2 and cfv.entry_id = e.id");
    expect(sql).toContain("limit 1) asc nulls last, e.created_at desc, e.id desc");
    expect(listCall?.[1]).toEqual(["seed_obj_people_00000000000000", "f5", 100, 0]);
  });

  it("searches custom text fields with a single field-id array exists condition", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    await getPostgresObjectData("people", new URL("http://localhost?search=silverlake"));

    const countCall = queryPg.mock.calls.find(([sql]) => String(sql).includes("select count(*)"));
    const sql = String(countCall?.[0]);

    expect(sql).toContain("exists (select 1 from crm_custom_field_values cfv");
    expect(sql).toContain("cfv.entry_id = e.id");
    expect(sql).toContain("cfv.field_id = any($3::text[])");
    expect(sql).toContain("lower(coalesce(cfv.text_value, cfv.json_value::text, '')) like lower($2)");
    expect(sql).not.toContain("limit 1)::text) like lower($2)");
    expect(countCall?.[1]).toEqual(["seed_obj_people_00000000000000", "%silverlake%", ["f5"]]);
  });

  it("adds relation metadata, labels, and favicons for company relations", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("people", new URL("http://localhost"));

    expect(data.fields.find((field) => field.name === "Company")?.related_object_name).toBe("company");
    expect(data.relationLabels.Company.c1).toBe("Acme");
    expect(data.relationFaviconUrls.Company.c1).toContain("google.com/s2/favicons");
  });

  it("loads entries for custom-value-only objects such as task", async () => {
    const { getPostgresObjectData } = await import("./object-read");
    const data = await getPostgresObjectData("task", new URL("http://localhost?pageSize=10"));

    expect(data.object.name).toBe("task");
    expect(data.totalCount).toBe(1);
    expect(data.entries[0]).toMatchObject({
      entry_id: "t1",
      Title: "Prepare investor deck",
      Status: "In Queue",
    });
  });
});
