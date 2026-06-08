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
		queryPg
			.mockResolvedValueOnce([{ entity_table: "crm_companies" }])
			.mockResolvedValueOnce([{ cnt: 1 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("company", "company-1")).resolves.toBe(true);
		expect(queryPg).toHaveBeenNthCalledWith(
			1,
			expect.stringContaining("from crm_objects"),
			["company"],
		);
		expect(queryPg).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("from crm_companies"),
			["company-1"],
		);
	});

	it("infers canonical entity tables when crm_objects.entity_table is null", async () => {
		queryPg
			.mockResolvedValueOnce([{ entity_table: null }])
			.mockResolvedValueOnce([{ cnt: 1 }]);

		const { verifyPostgresEntryExists } = await import("./documents");

		await expect(verifyPostgresEntryExists("people", "person-1")).resolves.toBe(true);
		expect(queryPg).toHaveBeenNthCalledWith(
			2,
			expect.stringContaining("from crm_people"),
			["person-1"],
		);
	});
});
