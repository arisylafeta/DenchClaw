import {
  isolatedBackendResponse,
  requiresIsolatedPostgres,
} from "@/lib/crm-postgres/user-scope";
import { currentUser } from "@/lib/auth";
import { duckdbExecOnFile, duckdbQueryOnFile, findDuckDBForObject } from "@/lib/workspace";
import { bulkDeletePostgresEntries } from "@/lib/crm-postgres/entry-mutations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * POST /api/workspace/objects/[name]/entries/bulk-delete
 * Delete multiple entries at once.
 * Body: { entryIds: string[] }
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name" },
			{ status: 400 },
		);
	}

	let body: { entryIds?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body." }, { status: 400 });
	}
	const entryIds = body.entryIds;

	if (!Array.isArray(entryIds) || entryIds.length === 0) {
		return Response.json(
			{ error: "entryIds must be a non-empty array" },
			{ status: 400 },
		);
	}
	if (entryIds.some((id) => typeof id !== "string" || id.trim() === "")) {
		return Response.json(
			{ error: "entryIds must contain only non-empty strings" },
			{ status: 400 },
		);
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
    const user = await currentUser();
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
		try {
      const deleted = await bulkDeletePostgresEntries(name, entryIds, user.id);
			return Response.json(Object.assign({ ok: true }, deleted));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to delete entries";
			const status = /read.only/i.test(message)
				? 403
				: /not found/i.test(message)
					? 404
					: /linked CRM records|foreign key|referenced|depend/i.test(message)
						? 409
						: /invalid|must|required/i.test(message)
							? 400
							: 500;
			return Response.json({ error: message }, { status });
		}
	}

  if (requiresIsolatedPostgres(name)) return isolatedBackendResponse();

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json(
			{ error: "DuckDB not found" },
			{ status: 404 },
		);
	}

	// Validate object exists
	const objects = duckdbQueryOnFile<{ id: string }>(dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json(
			{ error: `Object '${name}' not found` },
			{ status: 404 },
		);
	}
	const objectId = objects[0].id;

	const idList = entryIds
		.map((id) => `'${sqlEscape(id)}'`)
		.join(",");

	// Delete field values first, then entries
	duckdbExecOnFile(dbFile,
		`DELETE FROM entry_fields WHERE entry_id IN (${idList})`,
	);
	duckdbExecOnFile(dbFile,
		`DELETE FROM entries WHERE id IN (${idList}) AND object_id = '${sqlEscape(objectId)}'`,
	);

	return Response.json({
		ok: true,
		deletedCount: entryIds.length,
	});
}
