import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
	duckdbExecOnFileAsync,
	duckdbPathAsync,
	duckdbQueryOnFileAsync,
	resolveFilesystemPath,
	resolveWorkspaceRoot,
	writeObjectYaml,
} from "@/lib/workspace";
import { createPostgresObject } from "@/lib/crm-postgres/object-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

type CreateObjectBody = {
	name?: string;
	parentPath?: string;
	description?: string | null;
	icon?: string | null;
	default_view?: "table" | "kanban" | null;
};

/**
 * POST /api/workspace/objects
 * Create a new object/table in DuckDB and project it into the workspace tree.
 */
export async function POST(request: Request) {
	let body: CreateObjectBody;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const name = typeof body.name === "string" ? body.name.trim() : "";
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name. Use letters, numbers, and underscores only." },
			{ status: 400 },
		);
	}

	const parentPath = typeof body.parentPath === "string"
		? body.parentPath.trim()
		: body.parentPath == null
			? ""
			: undefined;
	if (parentPath === undefined) {
		return Response.json({ error: "Field 'parentPath' must be a string." }, { status: 400 });
	}

	const description = typeof body.description === "string"
		? body.description.trim() || null
		: body.description == null
			? null
			: undefined;
	if (description === undefined) {
		return Response.json({ error: "Field 'description' must be a string or null." }, { status: 400 });
	}

	const icon = typeof body.icon === "string"
		? body.icon.trim() || "table"
		: body.icon == null
			? "table"
			: undefined;
	if (icon === undefined) {
		return Response.json({ error: "Field 'icon' must be a string or null." }, { status: 400 });
	}

	const defaultView = body.default_view === "kanban"
		? "kanban"
		: body.default_view == null || body.default_view === "table"
			? "table"
			: undefined;
	if (defaultView === undefined) {
		return Response.json({ error: "Field 'default_view' must be 'table' or 'kanban'." }, { status: 400 });
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
		try {
		const created = await createPostgresObject({
			name,
			parentPath: parentPath || undefined,
			description,
			defaultView,
		});
			return Response.json(Object.assign({ ok: true }, created), { status: 201 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to create object.";
			const status = /not found/i.test(message)
				? 404
				: /already exists|duplicate/i.test(message)
					? 409
					: /invalid|must|required/i.test(message)
						? 400
					: 500;
			return Response.json({ error: message }, { status });
		}
	}

	const workspaceRoot = resolveWorkspaceRoot();
	if (!workspaceRoot) {
		return Response.json({ error: "Workspace root not found." }, { status: 404 });
	}

	const dbFile = await duckdbPathAsync();
	if (!dbFile) {
		return Response.json({ error: "DuckDB not found." }, { status: 404 });
	}

	const resolvedRoot = resolve(workspaceRoot);
	const rootPrefix = resolvedRoot + sep;
	let parentDir = workspaceRoot;
	let parentWorkspacePath = "";
	if (parentPath) {
		const resolvedParent = resolveFilesystemPath(parentPath);
		if (!resolvedParent?.withinWorkspace || resolvedParent.workspaceRelativePath == null) {
			return Response.json({ error: "Parent path must be inside the workspace." }, { status: 400 });
		}
		const absParent = resolve(resolvedParent.absolutePath);
		if (!absParent.startsWith(rootPrefix)) {
			return Response.json({ error: "Parent path must be inside the workspace." }, { status: 400 });
		}
		try {
			if (!statSync(absParent).isDirectory()) {
				return Response.json({ error: "Parent path must be a directory." }, { status: 400 });
			}
		} catch {
			return Response.json({ error: "Parent path does not exist." }, { status: 400 });
		}
		parentDir = absParent;
		parentWorkspacePath = resolvedParent.workspaceRelativePath;
	}

	const duplicate = await duckdbQueryOnFileAsync<{ id: string }>(
		dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (duplicate.length > 0) {
		return Response.json({ error: "An object with that name already exists." }, { status: 409 });
	}

	const objectDir = join(parentDir, name);
	if (!objectDir.startsWith(rootPrefix)) {
		return Response.json({ error: "Object path must be inside the workspace." }, { status: 400 });
	}
	if (existsSync(objectDir)) {
		return Response.json(
			{ error: "A file or folder with that name already exists in the target location." },
			{ status: 409 },
		);
	}

	const orderRows = await duckdbQueryOnFileAsync<{ max_order: number }>(
		dbFile,
		"SELECT COALESCE(MAX(sort_order), -1) as max_order FROM objects",
	);
	const sortOrder = (orderRows[0]?.max_order ?? -1) + 1;

	const idRows = await duckdbQueryOnFileAsync<{ id: string }>(
		dbFile,
		"SELECT uuid()::VARCHAR as id",
	);
	const objectId = idRows[0]?.id;
	if (!objectId) {
		return Response.json({ error: "Failed to generate object ID." }, { status: 500 });
	}

	const now = new Date().toISOString();
	// NOTE: `icon` is intentionally NOT in this INSERT. The
	// `migrateIconsFromDuckdbToYaml` migration drops the `icon` column
	// from `objects` (it now lives only in `<objectDir>/.object.yaml`),
	// so any INSERT referencing it would fail on post-migration
	// workspaces. The `icon` value is still passed to `writeObjectYaml`
	// below — that is the single source of truth.
	const created = await duckdbExecOnFileAsync(
		dbFile,
		`INSERT INTO objects (id, name, description, default_view, sort_order, created_at, updated_at)
		 VALUES ('${sqlEscape(objectId)}', '${sqlEscape(name)}', ${description ? `'${sqlEscape(description)}'` : "NULL"}, '${defaultView}', ${sortOrder}, '${now}', '${now}')`,
	);
	if (!created) {
		return Response.json({ error: "Failed to create object." }, { status: 500 });
	}

	try {
		mkdirSync(objectDir);
		writeObjectYaml(objectDir, {
			id: objectId,
			name,
			description: description ?? undefined,
			icon,
			default_view: defaultView,
			entry_count: 0,
			fields: [],
		});
	} catch (error) {
		await duckdbExecOnFileAsync(
			dbFile,
			`DELETE FROM objects WHERE id = '${sqlEscape(objectId)}'`,
		);
		rmSync(objectDir, { recursive: true, force: true });
		return Response.json(
			{ error: error instanceof Error ? error.message : "Failed to create object directory." },
			{ status: 500 },
		);
	}

	const path = parentWorkspacePath ? `${parentWorkspacePath}/${name}` : name;
	return Response.json({ ok: true, id: objectId, name, path }, { status: 201 });
}
