import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./route";

const { updatePostgresField, deletePostgresField } = vi.hoisted(() => ({
	updatePostgresField: vi.fn(async () => ({ ok: true })),
	deletePostgresField: vi.fn(async () => ({ ok: true })),
}));

const {
	duckdbExecOnFileMock,
	duckdbQueryOnFileMock,
	findDuckDBForObjectMock,
	findObjectDirMock,
	readObjectYamlMock,
	writeObjectYamlMock,
} = vi.hoisted(() => ({
	duckdbExecOnFileMock: vi.fn(),
	duckdbQueryOnFileMock: vi.fn(),
	findDuckDBForObjectMock: vi.fn(),
	findObjectDirMock: vi.fn(),
	readObjectYamlMock: vi.fn(),
	writeObjectYamlMock: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
	duckdbExecOnFile: duckdbExecOnFileMock,
	duckdbQueryOnFile: duckdbQueryOnFileMock,
	findDuckDBForObject: findDuckDBForObjectMock,
	findObjectDir: findObjectDirMock,
	pivotViewIdentifier: (objectName: string) => `"v_${objectName}"`,
	readObjectYaml: readObjectYamlMock,
	writeObjectYaml: writeObjectYamlMock,
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({
	updatePostgresField,
	deletePostgresField,
}));

describe("workspace field metadata API", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findDuckDBForObjectMock.mockReturnValue("/ws/workspace.duckdb");
		findObjectDirMock.mockReturnValue("/ws/leads");
		readObjectYamlMock.mockReturnValue({});
		duckdbExecOnFileMock.mockReturnValue(true);
		duckdbQueryOnFileMock.mockImplementation((_dbFile: string, sql: string) => {
			if (sql.includes("SELECT id FROM objects")) {
				return [{ id: "obj_leads" }];
			}
			if (sql.includes("SELECT type, enum_values FROM fields")) {
				return [{
					type: "enum",
					enum_values: JSON.stringify(["Lead", "Customer", "Churned"]),
				}];
			}
			if (sql.includes("SELECT name FROM fields")) {
				return [{ name: "Status" }];
			}
			if (sql.includes("SELECT name, type, required, enum_values")) {
				return [{
					name: "Status",
					type: "enum",
					required: false,
					enum_values: JSON.stringify(["Lead", "Customer"]),
					default_value: null,
					sort_order: 0,
				}];
			}
			if (sql.includes("SELECT COUNT(*) as cnt FROM entries")) {
				return [{ cnt: 2 }];
			}
			return [];
		});
	});

	it("updates select options and clears removed values from entries", async () => {
		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enum_values: ["Lead", "Customer"] }),
			}),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(200);
		expect(duckdbExecOnFileMock).toHaveBeenCalledWith(
			"/ws/workspace.duckdb",
			"UPDATE fields SET enum_values = '[\"Lead\",\"Customer\"]'::JSON WHERE id = 'status'",
		);
		expect(duckdbExecOnFileMock).toHaveBeenCalledWith(
			"/ws/workspace.duckdb",
			"UPDATE entry_fields SET value = NULL WHERE field_id = 'status' AND value IN ('Churned')",
		);
		expect(writeObjectYamlMock).toHaveBeenCalledWith(
			"/ws/leads",
			expect.objectContaining({
				entry_count: 2,
				fields: [
					{
						name: "Status",
						type: "enum",
						enum_values: ["Lead", "Customer"],
					},
				],
			}),
		);
	});

	it("renames existing entry values when exactly one select option changes", async () => {
		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enum_values: ["Prospect", "Customer", "Churned"] }),
			}),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(200);
		expect(duckdbExecOnFileMock).toHaveBeenCalledWith(
			"/ws/workspace.duckdb",
			"UPDATE entry_fields SET value = 'Prospect' WHERE field_id = 'status' AND value = 'Lead'",
		);
		expect(duckdbExecOnFileMock).not.toHaveBeenCalledWith(
			"/ws/workspace.duckdb",
			expect.stringContaining("value = NULL"),
		);
	});

	it("rejects duplicate select options", async () => {
		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enum_values: ["Lead", "lead"] }),
			}),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			error: "enum_values must be an array of unique strings",
		});
	});

	it("uses postgres helper for PATCH and bypasses duckdb", async () => {
		process.env.CRM_DB_BACKEND = "postgres";
		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Lifecycle" }),
			}),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(200);
		expect(updatePostgresField).toHaveBeenCalledWith("leads", "status", { name: "Lifecycle" });
		expect(findDuckDBForObjectMock).not.toHaveBeenCalled();
		expect(duckdbQueryOnFileMock).not.toHaveBeenCalled();
		expect(duckdbExecOnFileMock).not.toHaveBeenCalled();
		delete process.env.CRM_DB_BACKEND;
	});

	it("returns 400 for invalid postgres PATCH body before helper", async () => {
		process.env.CRM_DB_BACKEND = "postgres";
		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: "{",
			}),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(400);
		expect(updatePostgresField).not.toHaveBeenCalled();
		expect(findDuckDBForObjectMock).not.toHaveBeenCalled();
		delete process.env.CRM_DB_BACKEND;
	});

	it("uses postgres helper for DELETE and bypasses duckdb", async () => {
		process.env.CRM_DB_BACKEND = "postgres";
		const { DELETE } = await import("./route");
		const res = await DELETE(
			new Request("http://localhost/api/workspace/objects/leads/fields/status", { method: "DELETE" }),
			{ params: Promise.resolve({ name: "leads", fieldId: "status" }) },
		);

		expect(res.status).toBe(200);
		expect(deletePostgresField).toHaveBeenCalledWith("leads", "status");
		expect(findDuckDBForObjectMock).not.toHaveBeenCalled();
		delete process.env.CRM_DB_BACKEND;
	});
});
