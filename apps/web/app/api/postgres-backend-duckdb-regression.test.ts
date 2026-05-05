import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	createPostgresObject,
	updatePostgresDisplayField,
	getPostgresEnrichmentTarget,
	queryPg,
} = vi.hoisted(() => ({
	createPostgresObject: vi.fn(),
	updatePostgresDisplayField: vi.fn(),
	getPostgresEnrichmentTarget: vi.fn(),
	queryPg: vi.fn(),
}));

const {
	duckdbPathAsync,
	duckdbExecOnFileAsync,
	duckdbQueryOnFileAsync,
	duckdbQueryAllAsync,
	discoverDuckDBPaths,
	findDuckDBForObjectAsync,
	pivotViewIdentifier,
	resolveWorkspaceRoot,
	resolveFilesystemPath,
	safeResolvePath,
	isProtectedSystemPath,
	readObjectYamlIcon,
} = vi.hoisted(() => ({
	duckdbPathAsync: vi.fn(async () => {
		throw new Error("duckdbPathAsync should not be called in postgres mode");
	}),
	duckdbExecOnFileAsync: vi.fn(async () => {
		throw new Error("duckdbExecOnFileAsync should not be called in postgres mode");
	}),
	duckdbQueryOnFileAsync: vi.fn(async () => {
		throw new Error("duckdbQueryOnFileAsync should not be called in postgres mode");
	}),
	duckdbQueryAllAsync: vi.fn(async () => {
		throw new Error("duckdbQueryAllAsync should not be called in postgres mode");
	}),
	discoverDuckDBPaths: vi.fn(() => {
		throw new Error("discoverDuckDBPaths should not be called in postgres mode");
	}),
	findDuckDBForObjectAsync: vi.fn(async () => {
		throw new Error("findDuckDBForObjectAsync should not be called in postgres mode");
	}),
	pivotViewIdentifier: vi.fn(() => {
		throw new Error("pivotViewIdentifier should not be called in postgres mode");
	}),
	resolveWorkspaceRoot: vi.fn(() => null),
	resolveFilesystemPath: vi.fn(() => ({ absolutePath: "/ws/object-dir", withinWorkspace: true, workspaceRelativePath: "object-dir" })),
	safeResolvePath: vi.fn(() => "/ws/object-dir"),
	isProtectedSystemPath: vi.fn(() => false),
	readObjectYamlIcon: vi.fn(() => "table"),
}));

const { statSyncMock, rmSyncMock } = vi.hoisted(() => ({
	statSyncMock: vi.fn(() => ({ isDirectory: () => true })),
	rmSyncMock: vi.fn(),
}));

vi.mock("node:fs", () => ({
	writeFileSync: vi.fn(),
	mkdirSync: vi.fn(),
	rmSync: rmSyncMock,
	statSync: statSyncMock,
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
}));

vi.mock("@/lib/workspace", () => ({
	duckdbPathAsync,
	duckdbExecOnFileAsync,
	duckdbQueryOnFileAsync,
	duckdbQueryAllAsync,
	discoverDuckDBPaths,
	findDuckDBForObjectAsync,
	pivotViewIdentifier,
	resolveWorkspaceRoot,
	resolveFilesystemPath,
	safeResolvePath,
	isProtectedSystemPath,
	readObjectYamlIcon,
	readWorkspaceFile: vi.fn(() => null),
	parseSimpleYaml: vi.fn(() => ({})),
	isDatabaseFile: vi.fn(() => false),
	writeObjectYaml: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/object-metadata", () => ({
	createPostgresObject,
	updatePostgresDisplayField,
}));

vi.mock("@/lib/crm-postgres/enrich-target", () => ({
	getPostgresEnrichmentTarget,
}));

vi.mock("@/lib/postgres", () => ({
	queryPg,
}));

describe("postgres backend routes avoid DuckDB helpers", () => {
	beforeEach(() => {
		process.env.CRM_DB_BACKEND = "postgres";
		vi.clearAllMocks();
		resolveWorkspaceRoot.mockReturnValue(null);
		resolveFilesystemPath.mockReturnValue({
			absolutePath: "/ws/object-dir",
			withinWorkspace: true,
			workspaceRelativePath: "object-dir",
		});
		safeResolvePath.mockReturnValue("/ws/object-dir");
		isProtectedSystemPath.mockReturnValue(false);
		statSyncMock.mockReturnValue({ isDirectory: () => true });
	});

	afterEach(() => {
		delete process.env.CRM_DB_BACKEND;
	});

	it("uses postgres helper for object create", async () => {
		createPostgresObject.mockResolvedValue({ id: "obj_1", name: "leads", path: "leads" });
		const { POST } = await import("./workspace/objects/route");

		const res = await POST(new Request("http://localhost/api/workspace/objects", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "leads" }),
		}));

		expect(res.status).toBe(201);
		expect(createPostgresObject).toHaveBeenCalledWith(expect.objectContaining({ name: "leads" }));
		expect(duckdbPathAsync).not.toHaveBeenCalled();
		expect(duckdbQueryOnFileAsync).not.toHaveBeenCalled();
		expect(duckdbExecOnFileAsync).not.toHaveBeenCalled();
	});

	it("uses postgres helper for display field updates", async () => {
		updatePostgresDisplayField.mockResolvedValue({ ok: true, displayField: "Name" });
		const { PATCH } = await import("./workspace/objects/[name]/display-field/route");

		const res = await PATCH(
			new Request("http://localhost/api/workspace/objects/leads/display-field", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ displayField: "Name" }),
			}),
			{ params: Promise.resolve({ name: "leads" }) },
		);

		expect(res.status).toBe(200);
		expect(updatePostgresDisplayField).toHaveBeenCalledWith("leads", "Name");
		expect(duckdbQueryOnFileAsync).not.toHaveBeenCalled();
		expect(duckdbExecOnFileAsync).not.toHaveBeenCalled();
	});

	it("serves search index in postgres mode without duckdb queries", async () => {
		queryPg.mockResolvedValue([]);
		const { GET } = await import("./workspace/search-index/route");

		const res = await GET();
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(Array.isArray(json.items)).toBe(true);
		expect(json.items.some((item: { id: string }) => item.id === "~crm/people")).toBe(true);
		expect(discoverDuckDBPaths).not.toHaveBeenCalled();
		expect(duckdbQueryAllAsync).not.toHaveBeenCalled();
		expect(duckdbQueryOnFileAsync).not.toHaveBeenCalled();
	});

	it("uses postgres enrichment target helper", async () => {
		getPostgresEnrichmentTarget.mockResolvedValue({ lookupValue: "person@example.com" });
		const { POST } = await import("./crm/enrich/[type]/[id]/route");

		const res = await POST(
			new Request("http://localhost/api/crm/enrich/people/p_1", { method: "POST" }),
			{ params: Promise.resolve({ type: "people", id: "p_1" }) },
		);

		expect(res.status).toBe(501);
		expect(getPostgresEnrichmentTarget).toHaveBeenCalledWith("people", "p_1");
		expect(duckdbQueryOnFileAsync).not.toHaveBeenCalled();
		expect(duckdbQueryAllAsync).not.toHaveBeenCalled();
	});

	it("deletes folder in postgres mode without dropping duckdb pivot views", async () => {
		const { DELETE } = await import("./workspace/file/route");

		const res = await DELETE(new Request("http://localhost/api/workspace/file", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "object-dir" }),
		}));

		expect(res.status).toBe(200);
		expect(rmSyncMock).toHaveBeenCalledWith("/ws/object-dir", { recursive: true });
		expect(findDuckDBForObjectAsync).not.toHaveBeenCalled();
		expect(duckdbPathAsync).not.toHaveBeenCalled();
		expect(duckdbExecOnFileAsync).not.toHaveBeenCalled();
	});
});
