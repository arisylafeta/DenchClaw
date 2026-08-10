import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("@/lib/postgres", () => ({
  queryPg,
}));

vi.mock("node:fs", () => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: vi.fn(() => null),
  parseSimpleYaml: vi.fn(),
  duckdbQueryAllAsync: vi.fn(async () => []),
  discoverDuckDBPaths: vi.fn(() => []),
  duckdbQueryOnFileAsync: vi.fn(async () => []),
  duckdbExecOnFileAsync: vi.fn(async () => true),
  isDatabaseFile: vi.fn(() => false),
  pivotViewIdentifier: (name: string) => `"v_${name.replace(/"/g, '""')}"`,
  readObjectYamlIcon: vi.fn(() => undefined),
}));

describe("GET /api/workspace/search-index (postgres)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRM_DB_BACKEND = "postgres";
    queryPg.mockReset();

    queryPg.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from crm_objects") && !sql.includes("where name = $1")) {
        return [
          { id: "obj_company", name: "company", display_field: "Name" },
          { id: "obj_opportunity", name: "opportunity", display_field: "Name" },
        ];
      }
      if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
        if (params?.[0] === "obj_opportunity") {
          return [
            { id: "of1", name: "Name", type: "text", canonical_column: "title", sort_order: 1 },
            { id: "of2", name: "Status", type: "text", canonical_column: "status", sort_order: 2 },
            { id: "of3", name: "Amount", type: "number", canonical_column: "price_amount", sort_order: 3 },
          ];
        }
        return [
          { id: "f1", name: "Name", type: "text", canonical_column: "name", sort_order: 1 },
          { id: "f2", name: "Strength Score", type: "number", canonical_column: "strength_score", sort_order: 2 },
          { id: "f3", name: "Domain", type: "url", canonical_column: "domain", sort_order: 3 },
        ];
      }
      if (sql.includes("from information_schema.columns")) {
        if (params?.[0] === "crm_commercial_opportunities") {
          return [
            { column_name: "id" },
            { column_name: "created_at" },
            { column_name: "updated_at" },
            { column_name: "title" },
            { column_name: "status" },
            { column_name: "price_amount" },
          ];
        }
        return [
          { column_name: "id" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
          { column_name: "name" },
          { column_name: "domain" },
        ];
      }
      if (sql.includes("from crm_commercial_opportunities")) {
        return [{ entry_id: "o1", created_at: "2026-01-01", updated_at: "2026-01-01", Name: "Retired EV packs", Status: "open", Amount: 125000 }];
      }
      if (sql.includes("from crm_companies")) {
        return [{ entry_id: "c1", created_at: "2026-01-01", updated_at: "2026-01-01", Name: "Acme", Domain: "acme.test" }];
      }
      return [];
    });
  });

  it("does not reference canonical columns that are absent from the backing table", async () => {
    const { GET } = await import("./route");
    const res = await GET();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "entry:company:c1",
          label: "Acme",
          kind: "entry",
        }),
      ]),
    );

    const companySelectCall = queryPg.mock.calls.find(
      ([sql]) => String(sql).startsWith("select id as entry_id") && String(sql).includes("from crm_companies"),
    );
    const companySelectSql = String(companySelectCall?.[0]);
    expect(companySelectSql).toContain('"name" as "Name"');
    expect(companySelectSql).toContain('"domain" as "Domain"');
    expect(companySelectSql).not.toContain('"strength_score"');
  });

  it("indexes opportunity entries from crm_commercial_opportunities", async () => {
    const { GET } = await import("./route");
    const res = await GET();
    const json = await res.json();

    expect(json.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "entry:opportunity:o1",
          label: "Retired EV packs",
          kind: "entry",
        }),
      ]),
    );
  });
});
