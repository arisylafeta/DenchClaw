import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock workspace (include ALL exports used by the routes)
vi.mock("@/lib/workspace", () => ({
  safeResolvePath: vi.fn(() => null),
  resolveWorkspaceRoot: vi.fn(() => null),
  resolveDuckdbBin: vi.fn(() => null),
  duckdbPath: vi.fn(() => null),
  duckdbQuery: vi.fn(() => []),
  duckdbQueryAsync: vi.fn(async () => []),
  duckdbQueryOnFile: vi.fn(() => []),
  duckdbQueryOnFileAsync: vi.fn(async () => []),
  duckdbExecOnFile: vi.fn(() => true),
  discoverDuckDBPaths: vi.fn(() => []),
  isDatabaseFile: vi.fn(() => false),
}));

// Mock report-filters
vi.mock("@/lib/report-filters", () => ({
  buildFilterClauses: vi.fn(() => []),
  injectFilters: vi.fn((sql: string) => sql),
  checkSqlSafety: vi.fn(() => null),
}));

vi.mock("@/lib/crm-postgres/sql-execution", () => ({
  postgresReadOnlyQuery: vi.fn(async () => []),
  introspectPostgresCrm: vi.fn(async () => []),
}));

describe("Workspace DB & Reports API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mock("@/lib/workspace", () => ({
      safeResolvePath: vi.fn(() => null),
      resolveWorkspaceRoot: vi.fn(() => null),
      resolveDuckdbBin: vi.fn(() => null),
      duckdbPath: vi.fn(() => null),
      duckdbQuery: vi.fn(() => []),
      duckdbQueryAsync: vi.fn(async () => []),
      duckdbQueryOnFile: vi.fn(() => []),
      duckdbQueryOnFileAsync: vi.fn(async () => []),
      duckdbExecOnFile: vi.fn(() => true),
      discoverDuckDBPaths: vi.fn(() => []),
      isDatabaseFile: vi.fn(() => false),
    }));
    vi.mock("@/lib/report-filters", () => ({
      buildFilterClauses: vi.fn(() => []),
      injectFilters: vi.fn((sql: string) => sql),
      checkSqlSafety: vi.fn(() => null),
    }));
    vi.mock("@/lib/crm-postgres/sql-execution", () => ({
      postgresReadOnlyQuery: vi.fn(async () => []),
      introspectPostgresCrm: vi.fn(async () => []),
    }));
    delete process.env.CRM_DB_BACKEND;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── POST /api/workspace/db/query ───────────────────────────────

  describe("POST /api/workspace/db/query", () => {
    it("returns 400 for missing sql", async () => {
      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test.duckdb" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 400 for missing path", async () => {
      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects mutation queries with 403", async () => {
      const { safeResolvePath } = await import("@/lib/workspace");
      vi.mocked(safeResolvePath).mockReturnValue("/ws/test.duckdb");

      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test.duckdb", sql: "DROP TABLE users" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it("executes query and returns rows", async () => {
      const { safeResolvePath, duckdbQueryOnFileAsync } = await import("@/lib/workspace");
      vi.mocked(safeResolvePath).mockReturnValue("/ws/test.duckdb");
      vi.mocked(duckdbQueryOnFileAsync).mockResolvedValue([{ id: 1, name: "test" }]);

      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test.duckdb", sql: "SELECT * FROM t" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.rows).toEqual([{ id: 1, name: "test" }]);
    });

    it("returns empty rows for empty result", async () => {
      const { safeResolvePath, duckdbQueryOnFileAsync } = await import("@/lib/workspace");
      vi.mocked(safeResolvePath).mockReturnValue("/ws/test.duckdb");
      vi.mocked(duckdbQueryOnFileAsync).mockResolvedValue([]);

      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "test.duckdb", sql: "SELECT * FROM empty" }),
      });
      const res = await POST(req);
      const json = await res.json();
      expect(json.rows).toEqual([]);
    });

    it("uses postgres helper for app db path in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const { postgresReadOnlyQuery } = await import("@/lib/crm-postgres/sql-execution");
      vi.mocked(postgresReadOnlyQuery).mockResolvedValue([{ id: "pg-1" }]);

      const { POST } = await import("./db/query/route.js");
      const req = new Request("http://localhost/api/workspace/db/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "app://crm", sql: "SELECT 1 as id" }),
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(postgresReadOnlyQuery).toHaveBeenCalledWith("SELECT 1 as id");
      expect(json.rows).toEqual([{ id: "pg-1" }]);
    });
  });

  // ─── GET /api/workspace/db/introspect ───────────────────────────

  describe("GET /api/workspace/db/introspect", () => {
    it("returns 400 for missing path", async () => {
      const { GET } = await import("./db/introspect/route.js");
      const req = new Request("http://localhost/api/workspace/db/introspect");
      const res = await GET(req);
      expect(res.status).toBe(400);
    });

    it("returns 404 when file not found", async () => {
      const { safeResolvePath } = await import("@/lib/workspace");
      vi.mocked(safeResolvePath).mockReturnValue(null);

      const { GET } = await import("./db/introspect/route.js");
      const req = new Request("http://localhost/api/workspace/db/introspect?path=missing.duckdb");
      const res = await GET(req);
      expect(res.status).toBe(404);
    });

    it("returns schema when database exists", async () => {
      const { safeResolvePath, resolveDuckdbBin, duckdbQueryOnFile } = await import("@/lib/workspace");
      vi.mocked(safeResolvePath).mockReturnValue("/ws/test.duckdb");
      vi.mocked(resolveDuckdbBin).mockReturnValue("/opt/homebrew/bin/duckdb");
      vi.mocked(duckdbQueryOnFile).mockReturnValue([
        { table_name: "users", column_name: "id", data_type: "INTEGER", is_nullable: "NO" },
      ]);

      const { GET } = await import("./db/introspect/route.js");
      const req = new Request("http://localhost/api/workspace/db/introspect?path=test.duckdb");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.tables).toBeDefined();
    });

    it("uses postgres introspection helper for app db path in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const { introspectPostgresCrm } = await import("@/lib/crm-postgres/sql-execution");
      vi.mocked(introspectPostgresCrm).mockResolvedValue([
        {
          table_name: "crm_people",
          column_count: 1,
          estimated_row_count: 0,
          columns: [{ name: "id", type: "text", is_nullable: false }],
        },
      ]);

      const { GET } = await import("./db/introspect/route.js");
      const req = new Request("http://localhost/api/workspace/db/introspect?path=app://crm");
      const res = await GET(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(introspectPostgresCrm).toHaveBeenCalled();
      expect(json.tables[0]?.table_name).toBe("crm_people");
    });
  });

  // ─── POST /api/workspace/reports/execute ────────────────────────

  describe("POST /api/workspace/reports/execute", () => {
    it("returns 400 for missing sql", async () => {
      const { POST } = await import("./reports/execute/route.js");
      const req = new Request("http://localhost/api/workspace/reports/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("rejects mutation SQL with 403", async () => {
      const { checkSqlSafety } = await import("@/lib/report-filters");
      vi.mocked(checkSqlSafety).mockReturnValue("Only SELECT queries allowed");

      const { POST } = await import("./reports/execute/route.js");
      const req = new Request("http://localhost/api/workspace/reports/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "DROP TABLE users" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it("executes report query successfully", async () => {
      const { checkSqlSafety } = await import("@/lib/report-filters");
      vi.mocked(checkSqlSafety).mockReturnValue(null);
      const { duckdbQueryAsync } = await import("@/lib/workspace");
      vi.mocked(duckdbQueryAsync).mockResolvedValue([{ count: 42 }]);

      const { POST } = await import("./reports/execute/route.js");
      const req = new Request("http://localhost/api/workspace/reports/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT COUNT(*) as count FROM v_deals" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.rows).toEqual([{ count: 42 }]);
    });

    it("applies filters to SQL", async () => {
      const { checkSqlSafety, buildFilterClauses, injectFilters } = await import("@/lib/report-filters");
      vi.mocked(checkSqlSafety).mockReturnValue(null);
      vi.mocked(buildFilterClauses).mockReturnValue(['"Status" = \'Active\'']);
      vi.mocked(injectFilters).mockReturnValue("SELECT * FROM filtered");
      const { duckdbQueryAsync } = await import("@/lib/workspace");
      vi.mocked(duckdbQueryAsync).mockResolvedValue([{ count: 10 }]);

      const { POST } = await import("./reports/execute/route.js");
      const req = new Request("http://localhost/api/workspace/reports/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: "SELECT * FROM v_deals",
          filters: [{ id: "s", column: "Status", value: { type: "select", value: "Active" } }],
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(buildFilterClauses).toHaveBeenCalled();
      expect(injectFilters).toHaveBeenCalled();
    });

    it("uses postgres helper in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const { checkSqlSafety, injectFilters } = await import("@/lib/report-filters");
      vi.mocked(checkSqlSafety).mockReturnValue(null);
      vi.mocked(injectFilters).mockImplementation((sql: string) => sql);
      const { postgresReadOnlyQuery } = await import("@/lib/crm-postgres/sql-execution");
      vi.mocked(postgresReadOnlyQuery).mockResolvedValue([{ count: 7 }]);

      const { POST } = await import("./reports/execute/route.js");
      const req = new Request("http://localhost/api/workspace/reports/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT COUNT(*) as count FROM crm_people" }),
      });

      const res = await POST(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(postgresReadOnlyQuery).toHaveBeenLastCalledWith("SELECT COUNT(*) as count FROM crm_people");
      expect(json.rows).toEqual([{ count: 7 }]);
    });
  });

  describe("POST /api/workspace/execute", () => {
    it("uses postgres helper in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const { postgresReadOnlyQuery } = await import("@/lib/crm-postgres/sql-execution");
      vi.mocked(postgresReadOnlyQuery).mockResolvedValue([{ ok: true }]);

      const { POST } = await import("./execute/route.js");
      const req = new Request("http://localhost/api/workspace/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT true as ok" }),
      });

      const res = await POST(req);
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(postgresReadOnlyQuery).toHaveBeenCalledWith("SELECT true as ok");
      expect(json).toEqual({ rows: [{ ok: true }], ok: true });
    });
  });

  // ─── POST /api/workspace/query ─────────────────────────────────

  describe("POST /api/workspace/query", () => {
    it("returns 400 for missing sql", async () => {
      const { POST } = await import("./query/route.js");
      const req = new Request("http://localhost/api/workspace/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("executes query and returns rows", async () => {
      const { duckdbQueryAsync } = await import("@/lib/workspace");
      vi.mocked(duckdbQueryAsync).mockResolvedValue([{ id: 1 }]);

      const { POST } = await import("./query/route.js");
      const req = new Request("http://localhost/api/workspace/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 1 as id" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.rows).toEqual([{ id: 1 }]);
    });

    it("rejects mutation SQL with 403", async () => {
      const { POST } = await import("./query/route.js");
      const req = new Request("http://localhost/api/workspace/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "DELETE FROM users" }),
      });
      const res = await POST(req);
      expect(res.status).toBe(403);
    });

    it("uses postgres helper in postgres mode", async () => {
      process.env.CRM_DB_BACKEND = "postgres";
      const { postgresReadOnlyQuery } = await import("@/lib/crm-postgres/sql-execution");
      vi.mocked(postgresReadOnlyQuery).mockResolvedValue([{ id: 2 }]);

      const { POST } = await import("./query/route.js");
      const req = new Request("http://localhost/api/workspace/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "SELECT 2 as id" }),
      });
      const res = await POST(req);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(postgresReadOnlyQuery).toHaveBeenCalledWith("SELECT 2 as id");
      expect(json.rows).toEqual([{ id: 2 }]);
    });
  });
});
