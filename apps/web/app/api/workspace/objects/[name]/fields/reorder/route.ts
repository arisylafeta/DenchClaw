import { duckdbExecOnFile, duckdbQueryOnFile, findDuckDBForObject } from "@/lib/workspace";
import { reorderPostgresFields } from "@/lib/crm-postgres/object-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * PATCH /api/workspace/objects/[name]/fields/reorder
 * Reorder fields by updating sort_order.
 * Body: { fieldOrder: string[] } — array of field IDs in desired order
 */
export async function PATCH(
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

	const body = await req.json();
	const fieldOrder: string[] = body.fieldOrder;

	if (!Array.isArray(fieldOrder) || fieldOrder.length === 0) {
		return Response.json(
			{ error: "fieldOrder must be a non-empty array" },
			{ status: 400 },
		);
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
		try {
			const result = await reorderPostgresFields(name, fieldOrder);
			return Response.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to reorder fields";
			const status = /not found/i.test(message) ? 404 : /invalid|required|must/i.test(message) ? 400 : 500;
			return Response.json({ error: message }, { status });
		}
	}

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

	// Update sort_order for each field
	for (let i = 0; i < fieldOrder.length; i++) {
		duckdbExecOnFile(dbFile,
			`UPDATE fields SET sort_order = ${i} WHERE id = '${sqlEscape(fieldOrder[i])}' AND object_id = '${sqlEscape(objectId)}'`,
		);
	}

	return Response.json({ ok: true });
}
