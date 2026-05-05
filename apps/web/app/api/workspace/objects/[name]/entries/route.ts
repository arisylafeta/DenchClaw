import { duckdbExecOnFile, duckdbQueryOnFile, findDuckDBForObject } from "@/lib/workspace";
import { trackServer } from "@/lib/telemetry";
import { createPostgresEntry } from "@/lib/crm-postgres/entry-mutations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * POST /api/workspace/objects/[name]/entries
 * Create a new entry with optional field values.
 * Body: { fields?: Record<string, string> }
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

	if (process.env.CRM_DB_BACKEND === "postgres") {
		let body: { fields?: Record<string, string> } = {};
		try {
			body = await req.json();
		} catch {
			return Response.json({ error: "Invalid JSON body." }, { status: 400 });
		}
		if (body.fields != null && (typeof body.fields !== "object" || Array.isArray(body.fields))) {
			return Response.json({ error: "Field 'fields' must be an object." }, { status: 400 });
		}

		try {
			const created = await createPostgresEntry(name, body.fields ?? {});
			trackServer("object_entry_created");
			return Response.json(Object.assign({ ok: true }, created), { status: 201 });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to create entry";
			const status = /not found/i.test(message)
				? 404
				: /invalid|must|required|already exists|duplicate/i.test(message)
					? 400
					: 500;
			return Response.json({ error: message }, { status });
		}
	}

	let body: { fields?: Record<string, string> } = {};
	try {
		body = await req.json();
	} catch {
		// no body is fine
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json(
			{ error: "DuckDB not found" },
			{ status: 404 },
		);
	}

	// Find object
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

	// Generate UUID for the new entry
	const idRows = duckdbQueryOnFile<{ id: string }>(dbFile,
		"SELECT uuid()::VARCHAR as id",
	);
	const entryId = idRows[0]?.id;
	if (!entryId) {
		return Response.json(
			{ error: "Failed to generate UUID" },
			{ status: 500 },
		);
	}

	// Create entry
	const now = new Date().toISOString();
	const ok = duckdbExecOnFile(dbFile,
		`INSERT INTO entries (id, object_id, created_at, updated_at) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(objectId)}', '${now}', '${now}')`,
	);
	if (!ok) {
		return Response.json(
			{ error: "Failed to create entry" },
			{ status: 500 },
		);
	}

	// Insert field values if provided
	if (body.fields && typeof body.fields === "object") {
		// Get field IDs by name
		const dbFields = duckdbQueryOnFile<{ id: string; name: string }>(dbFile,
			`SELECT id, name FROM fields WHERE object_id = '${sqlEscape(objectId)}'`,
		);
		const fieldMap = new Map(dbFields.map((f) => [f.name, f.id]));

		for (const [fieldName, value] of Object.entries(body.fields)) {
			const fieldId = fieldMap.get(fieldName);
			if (!fieldId || value == null) {continue;}
			duckdbExecOnFile(dbFile,
				`INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(fieldId)}', '${sqlEscape(String(value))}')`,
			);
		}
	}

	trackServer("object_entry_created");

	return Response.json({ entryId, ok: true }, { status: 201 });
}
