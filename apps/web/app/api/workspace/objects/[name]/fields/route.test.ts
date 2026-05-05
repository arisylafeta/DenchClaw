import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createPostgresField = vi.fn(async () => ({ ok: true, fieldId: "f1", name: "Stage", type: "enum" }));

const workspaceMocks = vi.hoisted(() => ({
  duckdbExecOnFile: vi.fn(),
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
  findObjectDir: vi.fn(),
  pivotViewIdentifier: vi.fn(() => '"v_people"'),
  readObjectYaml: vi.fn(),
  writeObjectYaml: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({ createPostgresField }));
vi.mock("@/lib/workspace", () => workspaceMocks);

describe("fields route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
  });

  it("uses postgres helper for POST in postgres mode", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Stage", type: "enum", enum_values: ["Lead"] }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ok: true, fieldId: "f1" });
    expect(createPostgresField).toHaveBeenCalledWith("people", { name: "Stage", type: "enum", enum_values: ["Lead"] });
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
    expect(workspaceMocks.duckdbQueryOnFile).not.toHaveBeenCalled();
    expect(workspaceMocks.duckdbExecOnFile).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid postgres body before helper", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", type: "enum", enum_values: ["Lead"] }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(400);
    expect(createPostgresField).not.toHaveBeenCalled();
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
    expect(workspaceMocks.duckdbQueryOnFile).not.toHaveBeenCalled();
    expect(workspaceMocks.duckdbExecOnFile).not.toHaveBeenCalled();
  });
});
