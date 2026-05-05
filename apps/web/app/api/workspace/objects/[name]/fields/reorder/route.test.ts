import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reorderPostgresFields = vi.fn(async () => ({ ok: true }));

const workspaceMocks = vi.hoisted(() => ({
  duckdbExecOnFile: vi.fn(),
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({ reorderPostgresFields }));
vi.mock("@/lib/workspace", () => workspaceMocks);

describe("fields reorder route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CRM_DB_BACKEND;
  });

  it("uses postgres helper in postgres mode", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { PATCH } = await import("./route");
    const response = await PATCH(new Request("http://localhost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldOrder: ["f2", "f1"] }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(200);
    expect(reorderPostgresFields).toHaveBeenCalledWith("people", ["f2", "f1"]);
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body before helper", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { PATCH } = await import("./route");
    const response = await PATCH(new Request("http://localhost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldOrder: [] }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(400);
    expect(reorderPostgresFields).not.toHaveBeenCalled();
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });
});
