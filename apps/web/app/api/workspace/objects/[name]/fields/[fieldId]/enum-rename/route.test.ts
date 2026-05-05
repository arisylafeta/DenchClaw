import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renamePostgresEnumValue = vi.fn(async () => ({ ok: true, updated: true }));

const workspaceMocks = vi.hoisted(() => ({
  duckdbExecOnFile: vi.fn(),
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({ renamePostgresEnumValue }));
vi.mock("@/lib/workspace", () => workspaceMocks);

describe("enum rename route", () => {
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
      body: JSON.stringify({ oldValue: "Lead", newValue: "Prospect" }),
    }), { params: Promise.resolve({ name: "people", fieldId: "status" }) });

    expect(response.status).toBe(200);
    expect(renamePostgresEnumValue).toHaveBeenCalledWith("people", "status", "Lead", "Prospect");
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body before helper", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { PATCH } = await import("./route");
    const response = await PATCH(new Request("http://localhost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldValue: "", newValue: "Prospect" }),
    }), { params: Promise.resolve({ name: "people", fieldId: "status" }) });

    expect(response.status).toBe(400);
    expect(renamePostgresEnumValue).not.toHaveBeenCalled();
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });
});
