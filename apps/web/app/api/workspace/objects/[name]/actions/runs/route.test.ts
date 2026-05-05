import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace", () => ({
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/actions", () => ({
  getPostgresActionRuns: vi.fn(),
}));

describe("workspace object action runs route", () => {
  beforeEach(async () => {
    delete process.env.CRM_DB_BACKEND;
    vi.restoreAllMocks();
    const actionsPg = await import("@/lib/crm-postgres/actions");
    vi.mocked(actionsPg.getPostgresActionRuns).mockReset();
  });

  it("reads runs from Postgres helper in postgres mode", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const actionsPg = await import("@/lib/crm-postgres/actions");
    vi.mocked(actionsPg.getPostgresActionRuns).mockResolvedValue([
      { id: "run_1", action_id: "a1", field_id: "field_1", entry_id: "entry_1", status: "success" },
    ] as never);

    const { GET } = await import("./route.js");
    const response = await GET(
      new Request("http://localhost/api/workspace/objects/leads/actions/runs?fieldId=field_1&limit=5"),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runs: [{ id: "run_1", action_id: "a1", field_id: "field_1", entry_id: "entry_1", status: "success" }],
    });
    expect(actionsPg.getPostgresActionRuns).toHaveBeenCalledWith("leads", {
      fieldId: "field_1",
      entryId: null,
      actionId: null,
      limit: 5,
    });
  });
});
