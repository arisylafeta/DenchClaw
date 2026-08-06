import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
	queryPg,
}));

vi.mock("../workspace", () => ({
	findObjectDir: vi.fn(),
	resolveWorkspaceRoot: vi.fn(),
}));

describe("crm-postgres documents", () => {
	beforeEach(() => {
		vi.resetModules();
		queryPg.mockReset();
	});

	it("verifies entries against the object's Postgres entity table", async () => {
		queryPg.mockResolvedValueOnce([{ cnt: 1 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("company", "company-1")).resolves.toBe(true);
		expect(queryPg).toHaveBeenCalledWith(
			expect.stringContaining("from crm_companies"),
			["company-1"],
		);
	});

	it("infers canonical entity tables when crm_objects.entity_table is null", async () => {
		queryPg.mockResolvedValueOnce([{ cnt: 1 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("people", "person-1")).resolves.toBe(true);
		expect(queryPg).toHaveBeenCalledWith(
			expect.stringContaining("from crm_people"),
			["person-1"],
		);
	});

	it("verifies project and work-task entries against their canonical tables", async () => {
		queryPg.mockResolvedValue([{ cnt: 1 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("project", "project-1")).resolves.toBe(true);
		await expect(verifyPostgresEntryExists("work_task", "task-1")).resolves.toBe(true);
		expect(queryPg.mock.calls[0]?.[0]).toContain("from projects");
		expect(queryPg.mock.calls[1]?.[0]).toContain("from work_tasks");
	});

	it("returns false when entry is not found", async () => {
		queryPg.mockResolvedValueOnce([{ cnt: 0 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("company", "missing")).resolves.toBe(false);
	});

	it("returns false for unsupported object names", async () => {
		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("unknown_object", "x")).resolves.toBe(false);
		expect(queryPg).not.toHaveBeenCalled();
	});
});
