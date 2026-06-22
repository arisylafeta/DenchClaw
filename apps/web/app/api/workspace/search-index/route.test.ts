import { beforeEach, describe, expect, it, vi } from "vitest";

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
        return [{ id: "obj_company", name: "company", display_field: "Name" }];
      }
      if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
        return [
          { id: "f1", name: "Name", type: "text", canonical_column: "name", sort_order: 1 },
          { id: "f2", name: "Strength Score", type: "number", canonical_column: "strength_score", sort_order: 2 },
          { id: "f3", name: "Domain", type: "url", canonical_column: "domain", sort_order: 3 },
        ];
      }
      if (sql.includes("from information_schema.columns")) {
        return [
          { column_name: "id" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
          { column_name: "name" },
          { column_name: "domain" },
        ];
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
});
