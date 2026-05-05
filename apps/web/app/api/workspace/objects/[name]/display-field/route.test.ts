import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const updatePostgresDisplayField = vi.fn(async () => ({ ok: true, displayField: "Name" }));

const workspaceMocks = vi.hoisted(() => ({
  duckdbExecOnFile: vi.fn(),
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({ updatePostgresDisplayField }));
vi.mock("@/lib/workspace", () => workspaceMocks);

describe("display field route", () => {
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
      body: JSON.stringify({ displayField: "Name" }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(200);
    expect(updatePostgresDisplayField).toHaveBeenCalledWith("people", "Name");
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body before helper", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const { PATCH } = await import("./route");
    const response = await PATCH(new Request("http://localhost", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayField: "" }),
    }), { params: Promise.resolve({ name: "people" }) });

    expect(response.status).toBe(400);
    expect(updatePostgresDisplayField).not.toHaveBeenCalled();
    expect(workspaceMocks.findDuckDBForObject).not.toHaveBeenCalled();
  });
});
