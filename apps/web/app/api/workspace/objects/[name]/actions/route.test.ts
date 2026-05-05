import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/workspace", () => ({
  duckdbExecOnFile: vi.fn(),
  duckdbQueryOnFile: vi.fn(),
  findDuckDBForObject: vi.fn(),
  resolveWorkspaceRoot: vi.fn(() => "/tmp/workspace"),
  duckdbPath: vi.fn(() => "/tmp/workspace.duckdb"),
}));

vi.mock("@/lib/action-runner", () => ({
  runActionScript: vi.fn(async function* () {
    yield { type: "completed", entryId: "entry_1", status: "success", result: { ok: true } };
  }),
  runBulkAction: vi.fn(async function* () {
    yield { type: "completed", entryId: "entry_1", status: "success", result: { ok: true } };
  }),
}));

vi.mock("@/lib/crm-postgres/actions", () => ({
  getPostgresActionConfig: vi.fn(),
  getPostgresActionContexts: vi.fn(),
  persistPostgresActionRun: vi.fn(),
  getPostgresActionRuns: vi.fn(),
}));

describe("workspace object actions route", () => {
  beforeEach(async () => {
    delete process.env.CRM_DB_BACKEND;
    vi.restoreAllMocks();
    const actionsPg = await import("@/lib/crm-postgres/actions");
    vi.mocked(actionsPg.getPostgresActionConfig).mockReset();
    vi.mocked(actionsPg.getPostgresActionContexts).mockReset();
    vi.mocked(actionsPg.persistPostgresActionRun).mockReset();
  });

  it("uses Postgres config/context helpers and persists completed runs in postgres mode", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
    const actionsPg = await import("@/lib/crm-postgres/actions");
    vi.mocked(actionsPg.getPostgresActionConfig).mockResolvedValue({
      objectId: "obj_1",
      action: { id: "a1", label: "Run" },
    } as never);
    vi.mocked(actionsPg.getPostgresActionContexts).mockResolvedValue([
      {
        entryId: "entry_1",
        entryData: { Email: "jane@acme.com", entry_id: "entry_1" },
        objectName: "leads",
        objectId: "obj_1",
        actionId: "a1",
        fieldId: "field_1",
        workspacePath: "/tmp/workspace",
        dbPath: "",
        apiUrl: "http://localhost:3000/api",
      },
    ] as never);

    const { POST } = await import("./route.js");
    const response = await POST(
      new Request("http://localhost/api/workspace/objects/leads/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId: "a1", fieldId: "field_1", entryIds: ["entry_1"] }),
      }),
      { params: Promise.resolve({ name: "leads" }) },
    );

    expect(response.status).toBe(200);
    await response.text();
    expect(actionsPg.getPostgresActionConfig).toHaveBeenCalledWith("leads", "field_1", "a1");
    expect(actionsPg.getPostgresActionContexts).toHaveBeenCalledWith("leads", ["entry_1"]);
    expect(actionsPg.persistPostgresActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "a1",
        fieldId: "field_1",
        entryId: "entry_1",
        objectId: "obj_1",
        status: "success",
      }),
    );
  });
});
