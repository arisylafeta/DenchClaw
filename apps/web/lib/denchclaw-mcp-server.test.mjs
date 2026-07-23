import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock pg before importing the server. We expose a fake Pool whose .connect()
// returns a fake client with a query() spy.
const fakeQuery = vi.hoisted(() => vi.fn());
const fakeRelease = vi.hoisted(() => vi.fn());
const fakeClient = vi.hoisted(() => ({
  query: fakeQuery,
  release: fakeRelease,
}));
const fakePool = vi.hoisted(() => ({
  connect: vi.fn(async () => fakeClient),
}));

vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => fakePool) },
}));

// Import the module under test. Because startServer() only runs when invoked
// as the main entry point, importing here does not start stdio or exit.
const server = await import("./denchclaw-mcp-server.mjs");

const {
  TOOLS,
  executeTool,
  handleRequest,
  validateCompanyFields,
  validateCompanyCreateFields,
  validatePersonFields,
  validatePersonCreateFields,
  isMainEntry,
  __setPgPoolForTests,
  __resetPgPoolForTests,
} = server;

function toolNames() {
  return TOOLS.map((t) => t.name);
}

function parseResult(result) {
  // executeTool returns { content: [{ type: "text", text }] }
  return JSON.parse(result.content[0].text);
}

function makePoolReturningRows(rows, { rowCount } = {}) {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows, rowCount: rowCount ?? rows.length, command: "SELECT" })),
      release: vi.fn(),
    })),
  };
}

function makePoolWithQuerySpy(queryImpl) {
  const calls = [];
  const client = {
    query: vi.fn(async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl({ sql, params });
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, calls, client };
}

describe("denchclaw-mcp-server: module shape", () => {
  it("exports TOOLS, executeTool, handleRequest, and validators", () => {
    expect(Array.isArray(TOOLS)).toBe(true);
    expect(typeof executeTool).toBe("function");
    expect(typeof handleRequest).toBe("function");
    expect(typeof validateCompanyFields).toBe("function");
    expect(typeof validatePersonFields).toBe("function");
  });

  it("does not start stdio or exit on import", () => {
    // If we got here, the module imported without process.exit / readline binding.
    expect(true).toBe(true);
  });
});

describe("denchclaw-mcp-server: curated tool registration", () => {
  const expected = [
    "crm_schema_overview",
    "crm_get_company_profile",
    "crm_get_person_profile",
    "crm_search_companies",
    "crm_search_people",
    "crm_create_company",
    "crm_create_person",
    "crm_update_company",
    "crm_update_person",
  ];

  it("registers all curated crm tools", () => {
    for (const name of expected) {
      expect(toolNames()).toContain(name);
    }
  });

  it("keeps crm_query, crm_execute, crm_tables", () => {
    expect(toolNames()).toContain("crm_query");
    expect(toolNames()).toContain("crm_execute");
    expect(toolNames()).toContain("crm_tables");
  });

  it("marks crm_execute as an escape hatch in its description", () => {
    const t = TOOLS.find((x) => x.name === "crm_execute");
    expect(t.description.toLowerCase()).toContain("escape hatch");
  });

  it("points agents to curated tools in crm_query description", () => {
    const t = TOOLS.find((x) => x.name === "crm_query");
    expect(t.description.toLowerCase()).toContain("curated");
  });
});

describe("validateCompanyFields", () => {
  it("accepts allowlisted fields", () => {
    const r = validateCompanyFields({ name: "Acme", domain: "acme.test", country: "US" });
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({ name: "Acme", domain: "acme.test", country: "US" });
  });

  it("does NOT require name by default (update-safe)", () => {
    // validateCompanyFields is the update validator: no required fields.
    const r = validateCompanyFields({ domain: "acme.test" });
    expect(r.ok).toBe(true);
    expect(r.fields.domain).toBe("acme.test");
  });

  it("requires name for create via validateCompanyCreateFields", () => {
    const r = validateCompanyCreateFields({ domain: "acme.test" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/name/i);
  });

  it("rejects unknown fields", () => {
    const r = validateCompanyFields({ name: "Acme", bogus: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown field "bogus"/i);
  });

  it("rejects empty writes", () => {
    const r = validateCompanyFields({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/at least one writable field/i);
  });

  it("rejects non-object fields", () => {
    expect(validateCompanyFields(null).ok).toBe(false);
    expect(validateCompanyFields("name").ok).toBe(false);
    expect(validateCompanyFields([]).ok).toBe(false);
  });

  it("rejects id/created_at/updated_at", () => {
    expect(validateCompanyFields({ id: "x" }).ok).toBe(false);
    expect(validateCompanyFields({ created_at: "x" }).ok).toBe(false);
    expect(validateCompanyFields({ updated_at: "x" }).ok).toBe(false);
  });
});

describe("validatePersonFields", () => {
  it("accepts allowlisted fields", () => {
    const r = validatePersonFields({ full_name: "Ada", email: "ada@example.com" });
    expect(r.ok).toBe(true);
    expect(r.fields.full_name).toBe("Ada");
  });

  it("rejects unknown fields", () => {
    const r = validatePersonFields({ full_name: "Ada", nope: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown field "nope"/i);
  });

  it("rejects empty writes", () => {
    expect(validatePersonFields({}).ok).toBe(false);
  });

  it("rejects id/created_at/updated_at", () => {
    expect(validatePersonFields({ id: "x" }).ok).toBe(false);
    expect(validatePersonFields({ updated_at: "x" }).ok).toBe(false);
  });
});

describe("executeTool: crm_schema_overview", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("returns a curated schema overview without touching the DB", async () => {
    const result = await executeTool("crm_schema_overview", {});
    const payload = parseResult(result);
    expect(payload.database).toBe("denchclaw");
    expect(payload.core_tables.map((t) => t.table)).toContain("crm_companies");
    expect(payload.core_tables.map((t) => t.table)).toContain("crm_people");
    expect(payload.views.map((v) => v.view)).toContain("crm_relation_links");
    expect(payload.curated_tools).toContain("crm_create_company");
    expect(payload.caveats.length).toBeGreaterThan(0);
  });
});

describe("executeTool: crm_get_company_profile", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("requires id", async () => {
    const result = await executeTool("crm_get_company_profile", {});
    expect(parseResult(result).error).toMatch(/id is required/i);
  });

  it("returns company + people when found", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/from crm_companies/.test(sql)) {
        return { rows: [{ id: "c1", name: "Acme", domain: "acme.test", person_count: 2 }] };
      }
      if (/from crm_people/.test(sql)) {
        return { rows: [{ id: "p1", full_name: "Ada", email: "ada@acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_get_company_profile", { id: "c1" });
    const payload = parseResult(result);
    expect(payload.company.name).toBe("Acme");
    expect(payload.people).toHaveLength(1);
    expect(payload.people[0].full_name).toBe("Ada");

    // Parameterized: id passed as $1
    const companyCall = calls.find((c) => /from crm_companies/.test(c.sql));
    expect(companyCall.params).toEqual(["c1"]);
  });

  it("returns error when not found", async () => {
    const pool = makePoolReturningRows([]);
    __setPgPoolForTests(pool);
    const result = await executeTool("crm_get_company_profile", { id: "missing" });
    expect(parseResult(result).error).toMatch(/not found/i);
  });
});

describe("executeTool: crm_get_person_profile", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("requires id", async () => {
    const result = await executeTool("crm_get_person_profile", {});
    expect(parseResult(result).error).toMatch(/id is required/i);
  });

  it("returns person with company join", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/from crm_people p/.test(sql)) {
        return { rows: [{ id: "p1", full_name: "Ada", email: "ada@acme.test", company_name: "Acme", company_domain: "acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_get_person_profile", { id: "p1" });
    const payload = parseResult(result);
    expect(payload.person.full_name).toBe("Ada");
    expect(payload.person.company_name).toBe("Acme");

    const call = calls.find((c) => /from crm_people p/.test(c.sql));
    expect(call.params).toEqual(["p1"]);
  });
});

describe("executeTool: crm_search_companies", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("returns rows and clamps to hard limit", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/from crm_companies/.test(sql)) {
        return { rows: [{ id: "c1", name: "Acme" }, { id: "c2", name: "Beta" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_search_companies", { query: "acme", limit: 9999 });
    const payload = parseResult(result);
    expect(payload.companies).toHaveLength(2);
    expect(payload.limit).toBe(50); // SEARCH_HARD_LIMIT

    const call = calls.find((c) => /from crm_companies/.test(c.sql));
    // last param is the limit
    expect(call.params[call.params.length - 1]).toBe(50);
    // query param is a LIKE pattern
    expect(call.params[0]).toBe("%acme%");
  });

  it("builds parameterized conditions for country", async () => {
    const { pool, calls } = makePoolWithQuerySpy(() => ({ rows: [] }));
    __setPgPoolForTests(pool);

    await executeTool("crm_search_companies", { country: "Germany" });
    const call = calls.find((c) => /from crm_companies/.test(c.sql));
    expect(call.sql).toMatch(/country/);
    expect(call.params).toContain("%germany%");
  });
});

describe("executeTool: crm_search_people", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("returns rows with company join", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/from crm_people p/.test(sql)) {
        return { rows: [{ id: "p1", full_name: "Ada", company_name: "Acme" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_search_people", { email: "ada" });
    const payload = parseResult(result);
    expect(payload.people).toHaveLength(1);
    expect(payload.people[0].company_name).toBe("Acme");

    const call = calls.find((c) => /from crm_people p/.test(c.sql));
    expect(call.params[0]).toBe("%ada%");
  });
});

describe("executeTool: crm_create_company", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("rejects missing name", async () => {
    const result = await executeTool("crm_create_company", { fields: { domain: "acme.test" } });
    expect(parseResult(result).error).toMatch(/name/i);
  });

  it("rejects unknown fields", async () => {
    const result = await executeTool("crm_create_company", { fields: { name: "Acme", bogus: 1 } });
    expect(parseResult(result).error).toMatch(/unknown field "bogus"/i);
  });

  it("rejects id in fields", async () => {
    const result = await executeTool("crm_create_company", { fields: { name: "Acme", id: "hax" } });
    expect(parseResult(result).error).toMatch(/id/i);
  });

  it("inserts with parameterized SQL and returning *", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^insert into "crm_companies"/.test(sql.trim())) {
        return { rows: [{ id: "c1", name: "Acme", domain: "acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_create_company", { fields: { name: "Acme", domain: "acme.test" } });
    const payload = parseResult(result);
    expect(payload.created).toBe(true);
    expect(payload.company.name).toBe("Acme");

    const insertCall = calls.find((c) => /^insert into "crm_companies"/.test(c.sql.trim()));
    expect(insertCall).toBeTruthy();
    expect(insertCall.sql).toMatch(/returning \*/);
    // First param is the server-generated id (UUID), followed by caller fields.
    expect(insertCall.params[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(insertCall.params.slice(1)).toEqual(["Acme", "acme.test"]);
    expect(insertCall.sql).not.toContain("'Acme'");
    // The "id" column is present in the INSERT.
    expect(insertCall.sql).toMatch(/"id"/);
  });

  it("generates a server-side id and surfaces it in the result", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^insert into "crm_companies"/.test(sql.trim())) {
        // Echo back the id the server generated (first param).
        return { rows: [{ id: "echoed-id", name: "Acme" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_create_company", { fields: { name: "Acme" } });
    const payload = parseResult(result);
    expect(payload.created).toBe(true);
    expect(typeof payload.id).toBe("string");
    expect(payload.id.length).toBeGreaterThan(0);

    const insertCall = calls.find((c) => /^insert into "crm_companies"/.test(c.sql.trim()));
    // The generated id is the first param and matches the surfaced id.
    expect(insertCall.params[0]).toBe(payload.id);
  });
});

describe("executeTool: crm_create_person", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("inserts and returns created row", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^insert into "crm_people"/.test(sql.trim())) {
        return { rows: [{ id: "p1", full_name: "Ada", email: "ada@acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_create_person", { fields: { full_name: "Ada", email: "ada@acme.test" } });
    const payload = parseResult(result);
    expect(payload.created).toBe(true);
    expect(payload.person.full_name).toBe("Ada");

    const insertCall = calls.find((c) => /^insert into "crm_people"/.test(c.sql.trim()));
    expect(insertCall.sql).toMatch(/returning \*/);
    // First param is the server-generated id (UUID), followed by caller fields.
    expect(insertCall.params[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(insertCall.params.slice(1)).toEqual(["Ada", "ada@acme.test"]);
  });

  it("rejects updated_at", async () => {
    const result = await executeTool("crm_create_person", { fields: { full_name: "Ada", updated_at: "now" } });
    expect(parseResult(result).error).toMatch(/updated_at/i);
  });
});

describe("executeTool: crm_update_company", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("requires id", async () => {
    const result = await executeTool("crm_update_company", { fields: { name: "Acme" } });
    expect(parseResult(result).error).toMatch(/id is required/i);
  });

  it("does NOT require name for updates", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^update "crm_companies"/.test(sql.trim())) {
        return { rows: [{ id: "c1", domain: "acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_update_company", { id: "c1", fields: { domain: "acme.test" } });
    const payload = parseResult(result);
    expect(payload.updated).toBe(true);
    expect(payload.company.domain).toBe("acme.test");

    const updateCall = calls.find((c) => /^update "crm_companies"/.test(c.sql.trim()));
    expect(updateCall.params).toEqual(["acme.test", "c1"]);
  });

  it("rejects empty fields", async () => {
    const result = await executeTool("crm_update_company", { id: "c1", fields: {} });
    expect(parseResult(result).error).toMatch(/at least one writable field/i);
  });

  it("updates with parameterized SQL, sets updated_at, returning *", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^update "crm_companies"/.test(sql.trim())) {
        return { rows: [{ id: "c1", name: "Acme2", domain: "acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_update_company", { id: "c1", fields: { name: "Acme2" } });
    const payload = parseResult(result);
    expect(payload.updated).toBe(true);
    expect(payload.company.name).toBe("Acme2");

    const updateCall = calls.find((c) => /^update "crm_companies"/.test(c.sql.trim()));
    expect(updateCall.sql).toMatch(/updated_at = now\(\)/);
    expect(updateCall.sql).toMatch(/returning \*/);
    expect(updateCall.params).toEqual(["Acme2", "c1"]);
    expect(updateCall.sql).not.toContain("'Acme2'");
  });

  it("returns error when row not found", async () => {
    const pool = makePoolReturningRows([]);
    __setPgPoolForTests(pool);
    const result = await executeTool("crm_update_company", { id: "missing", fields: { name: "X" } });
    expect(parseResult(result).error).toMatch(/not found/i);
  });
});

describe("executeTool: crm_update_person", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("updates and returns row", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^update "crm_people"/.test(sql.trim())) {
        return { rows: [{ id: "p1", full_name: "Ada2" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_update_person", { id: "p1", fields: { full_name: "Ada2" } });
    const payload = parseResult(result);
    expect(payload.updated).toBe(true);
    expect(payload.person.full_name).toBe("Ada2");

    const updateCall = calls.find((c) => /^update "crm_people"/.test(c.sql.trim()));
    expect(updateCall.params).toEqual(["Ada2", "p1"]);
  });

  it("does NOT require full_name for updates", async () => {
    const { pool, calls } = makePoolWithQuerySpy(({ sql }) => {
      if (/^update "crm_people"/.test(sql.trim())) {
        return { rows: [{ id: "p1", email: "ada2@acme.test" }] };
      }
      return { rows: [] };
    });
    __setPgPoolForTests(pool);

    const result = await executeTool("crm_update_person", { id: "p1", fields: { email: "ada2@acme.test" } });
    const payload = parseResult(result);
    expect(payload.updated).toBe(true);
    expect(payload.person.email).toBe("ada2@acme.test");

    const updateCall = calls.find((c) => /^update "crm_people"/.test(c.sql.trim()));
    expect(updateCall.params).toEqual(["ada2@acme.test", "p1"]);
  });

  it("rejects id in fields", async () => {
    const result = await executeTool("crm_update_person", { id: "p1", fields: { id: "hax" } });
    expect(parseResult(result).error).toMatch(/id/i);
  });
});

describe("executeTool: crm_query (fallback)", () => {
  beforeEach(() => __resetPgPoolForTests());
  afterEach(() => __resetPgPoolForTests());

  it("rejects non-SELECT", async () => {
    const result = await executeTool("crm_query", { sql: "DELETE FROM crm_companies" });
    expect(parseResult(result).error).toMatch(/select/i);
  });

  it("rejects multi-statement input", async () => {
    const result = await executeTool("crm_query", {
      sql: "SELECT 1; DROP TABLE crm_companies;",
    });
    expect(parseResult(result).error).toMatch(/multi-statement/i);
  });

  it("rejects multi-statement input with trailing second statement", async () => {
    const result = await executeTool("crm_query", {
      sql: "SELECT * FROM crm_companies; SELECT * FROM crm_people",
    });
    expect(parseResult(result).error).toMatch(/multi-statement/i);
  });

  it("allows a single trailing semicolon", async () => {
    const { pool, calls } = makePoolWithQuerySpy(() => ({ rows: [{ id: "c1" }] }));
    __setPgPoolForTests(pool);
    const result = await executeTool("crm_query", { sql: "SELECT * FROM crm_companies;" });
    const payload = parseResult(result);
    expect(payload.rows).toHaveLength(1);
    // The trailing semicolon is stripped before sending to the DB.
    const call = calls[0];
    expect(call.sql.endsWith(";")).toBe(false);
  });

  it("runs SELECT and returns rows", async () => {
    const pool = makePoolReturningRows([{ id: "c1", name: "Acme" }]);
    __setPgPoolForTests(pool);
    const result = await executeTool("crm_query", { sql: "SELECT * FROM crm_companies" });
    const payload = parseResult(result);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0].name).toBe("Acme");
  });

  it("injects LIMIT into SQL for simple SELECTs without a LIMIT clause", async () => {
    const { pool, calls } = makePoolWithQuerySpy(() => ({ rows: [] }));
    __setPgPoolForTests(pool);
    await executeTool("crm_query", { sql: "SELECT * FROM crm_companies", limit: 50 });
    const call = calls[0];
    expect(call.sql).toMatch(/limit 50$/i);
  });

  it("does not inject LIMIT when the query already has one", async () => {
    const { pool, calls } = makePoolWithQuerySpy(() => ({ rows: [] }));
    __setPgPoolForTests(pool);
    await executeTool("crm_query", { sql: "SELECT * FROM crm_companies LIMIT 5", limit: 50 });
    const call = calls[0];
    // Should not append a second LIMIT.
    expect((call.sql.match(/limit/gi) || []).length).toBe(1);
  });
});

describe("curated tool input schemas (nested fields)", () => {
  it("crm_create_company.fields has explicit properties for allowlisted fields", () => {
    const t = TOOLS.find((x) => x.name === "crm_create_company");
    const fieldsSchema = t.inputSchema.properties.fields;
    expect(fieldsSchema.type).toBe("object");
    expect(fieldsSchema.properties).toBeTruthy();
    expect(Object.keys(fieldsSchema.properties)).toContain("name");
    expect(Object.keys(fieldsSchema.properties)).toContain("domain");
    expect(fieldsSchema.required).toEqual(["name"]);
    // No additionalProperties:false that would imply zero properties.
    expect(fieldsSchema.additionalProperties).toBeUndefined();
  });

  it("crm_create_person.fields has explicit properties", () => {
    const t = TOOLS.find((x) => x.name === "crm_create_person");
    const fieldsSchema = t.inputSchema.properties.fields;
    expect(fieldsSchema.type).toBe("object");
    expect(Object.keys(fieldsSchema.properties)).toContain("full_name");
    expect(Object.keys(fieldsSchema.properties)).toContain("email");
    expect(fieldsSchema.additionalProperties).toBeUndefined();
  });

  it("crm_update_company.fields has explicit properties and no required", () => {
    const t = TOOLS.find((x) => x.name === "crm_update_company");
    const fieldsSchema = t.inputSchema.properties.fields;
    expect(fieldsSchema.type).toBe("object");
    expect(Object.keys(fieldsSchema.properties).length).toBeGreaterThan(0);
    expect(fieldsSchema.required).toBeUndefined();
    expect(fieldsSchema.additionalProperties).toBeUndefined();
  });

  it("crm_update_person.fields has explicit properties and no required", () => {
    const t = TOOLS.find((x) => x.name === "crm_update_person");
    const fieldsSchema = t.inputSchema.properties.fields;
    expect(fieldsSchema.type).toBe("object");
    expect(Object.keys(fieldsSchema.properties).length).toBeGreaterThan(0);
    expect(fieldsSchema.required).toBeUndefined();
    expect(fieldsSchema.additionalProperties).toBeUndefined();
  });

  it("create company schema marks id as server-generated in description", () => {
    const t = TOOLS.find((x) => x.name === "crm_create_company");
    expect(t.description.toLowerCase()).toContain("server-side");
  });
});

describe("isMainEntry", () => {
  it("returns false when argv1 is empty", () => {
    expect(isMainEntry("", "file:///abs/server.mjs")).toBe(false);
    expect(isMainEntry(undefined, "file:///abs/server.mjs")).toBe(false);
  });

  it("returns true when argv1 is an absolute path matching the module URL", () => {
    const modulePath = "/root/.hermes/projects/denchclaw/apps/web/lib/denchclaw-mcp-server.mjs";
    const moduleUrl = `file://${modulePath}`;
    expect(isMainEntry(modulePath, moduleUrl)).toBe(true);
  });

  it("returns true when argv1 is a relative path resolving to the module URL", () => {
    const modulePath = "/root/.hermes/projects/denchclaw/apps/web/lib/denchclaw-mcp-server.mjs";
    const moduleUrl = `file://${modulePath}`;
    // Simulate launching from the canonical project checkout with a relative path.
    expect(isMainEntry("apps/web/lib/denchclaw-mcp-server.mjs", moduleUrl, "/root/.hermes/projects/denchclaw")).toBe(true);
  });

  it("returns false when argv1 resolves to a different path", () => {
    const moduleUrl = "file:///root/.hermes/projects/denchclaw/apps/web/lib/denchclaw-mcp-server.mjs";
    expect(isMainEntry("/some/other/file.mjs", moduleUrl)).toBe(false);
  });
});

describe("handleRequest", () => {
  it("responds to initialize", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(res.id).toBe(1);
    expect(res.result.serverInfo.name).toBe("denchclaw");
  });

  it("lists tools including curated ones", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = res.result.tools.map((t) => t.name);
    expect(names).toContain("crm_create_company");
    expect(names).toContain("crm_search_people");
  });

  it("routes tools/call to executeTool", async () => {
    const res = await handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "crm_schema_overview", arguments: {} },
    });
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.database).toBe("denchclaw");
  });

  it("returns method not found for unknown methods", async () => {
    const res = await handleRequest({ jsonrpc: "2.0", id: 4, method: "nope" });
    expect(res.error.code).toBe(-32601);
  });
});
