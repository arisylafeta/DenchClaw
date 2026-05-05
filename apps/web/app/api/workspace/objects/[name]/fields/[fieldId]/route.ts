import {
	duckdbExecOnFile,
	duckdbQueryOnFile,
	findDuckDBForObject,
	findObjectDir,
	pivotViewIdentifier,
	readObjectYaml,
	writeObjectYaml,
} from "@/lib/workspace";
import { deletePostgresField, updatePostgresField } from "@/lib/crm-postgres/object-metadata";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * PATCH /api/workspace/objects/[name]/fields/[fieldId]
 * Update field metadata.
 * Body: { name?: string, default_value?: string | null, enum_values?: string[] }
 */
export async function PATCH(
	req: Request,
	{
		params,
	}: { params: Promise<{ name: string; fieldId: string }> },
) {
	const { name, fieldId } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name" },
			{ status: 400 },
		);
	}

	let body: Record<string, unknown>;
	try {
		body = await req.json();
	} catch {
		if (process.env.CRM_DB_BACKEND === "postgres") {
			return Response.json({ error: "Invalid JSON body." }, { status: 400 });
		}
		throw new Error("Invalid JSON body.");
	}
	const newName = typeof body.name === "string" ? body.name.trim() : null;
	const hasDefaultValue = Object.prototype.hasOwnProperty.call(body, "default_value");
	const defaultValue: unknown = body.default_value;
	const hasEnumValues = Object.prototype.hasOwnProperty.call(body, "enum_values");
	const enumValues = hasEnumValues ? normalizeEnumValues(body.enum_values) : null;

	if (
		(!newName || newName.length === 0)
		&& !hasDefaultValue
		&& !hasEnumValues
	) {
		return Response.json(
			{ error: "Name, default_value, or enum_values is required" },
			{ status: 400 },
		);
	}
	if (hasDefaultValue && defaultValue !== null && typeof defaultValue !== "string") {
		return Response.json(
			{ error: "default_value must be a string or null" },
			{ status: 400 },
		);
	}
	if (hasEnumValues && !enumValues) {
		return Response.json(
			{ error: "enum_values must be an array of unique strings" },
			{ status: 400 },
		);
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
		try {
			const result = await updatePostgresField(name, fieldId, body);
			return Response.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to rename field";
			const status = /not found/i.test(message)
				? 404
				: /already exists|duplicate/i.test(message)
					? 409
					: /invalid|required|must/i.test(message)
						? 400
						: 500;
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

	// Validate field exists and belongs to this object
	const fields = duckdbQueryOnFile<{ type: string; enum_values: string | null }>(dbFile,
		`SELECT type, enum_values FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(objectId)}'`,
	);
	if (fields.length === 0) {
		return Response.json(
			{ error: "Field not found" },
			{ status: 404 },
		);
	}
	const field = fields[0];
	if (hasEnumValues && field.type !== "enum") {
		return Response.json(
			{ error: "enum_values can only be updated for select fields" },
			{ status: 400 },
		);
	}

	if (newName && newName.length > 0) {
		// Check for duplicate name
		const duplicateCheck = duckdbQueryOnFile<{ cnt: number }>(dbFile,
			`SELECT COUNT(*) as cnt FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND name = '${sqlEscape(newName)}' AND id != '${sqlEscape(fieldId)}'`,
		);
		if (duplicateCheck[0]?.cnt > 0) {
			return Response.json(
				{ error: "A field with that name already exists" },
				{ status: 409 },
			);
		}
	}

	const updates: string[] = [];
	if (newName && newName.length > 0) {
		updates.push(`name = '${sqlEscape(newName)}'`);
	}
	if (hasDefaultValue) {
		updates.push(defaultValue === null ? "default_value = NULL" : `default_value = '${sqlEscape(defaultValue as string)}'`);
	}
	if (hasEnumValues && enumValues) {
		updates.push(`enum_values = '${sqlEscape(JSON.stringify(enumValues))}'::JSON`);
	}

	const ok = duckdbExecOnFile(dbFile,
		`UPDATE fields SET ${updates.join(", ")} WHERE id = '${sqlEscape(fieldId)}'`,
	);

	if (!ok) {
		return Response.json(
			{ error: "Failed to rename field" },
			{ status: 500 },
		);
	}

	if (hasEnumValues && enumValues) {
		const changes = getEnumValueChanges(field.enum_values, enumValues);
		if (
			changes.removed.length === 1
			&& changes.added.length === 1
			&& changes.currentLength === enumValues.length
		) {
			duckdbExecOnFile(dbFile,
				`UPDATE entry_fields SET value = '${sqlEscape(changes.added[0])}' WHERE field_id = '${sqlEscape(fieldId)}' AND value = '${sqlEscape(changes.removed[0])}'`,
			);
		} else if (changes.removed.length > 0) {
			const removedList = changes.removed.map((value) => `'${sqlEscape(value)}'`).join(", ");
			duckdbExecOnFile(dbFile,
				`UPDATE entry_fields SET value = NULL WHERE field_id = '${sqlEscape(fieldId)}' AND value IN (${removedList})`,
			);
		}
	}

	regeneratePivotView(dbFile, name, objectId);
	updateObjectYamlFields(name, dbFile, objectId);

	return Response.json({ ok: true });
}

/**
 * DELETE /api/workspace/objects/[name]/fields/[fieldId]
 * Remove a field and all its entry data.
 */
export async function DELETE(
	_req: Request,
	{
		params,
	}: { params: Promise<{ name: string; fieldId: string }> },
) {
	const { name, fieldId } = await params;

	if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
		return Response.json(
			{ error: "Invalid object name" },
			{ status: 400 },
		);
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
		try {
			const result = await deletePostgresField(name, fieldId);
			return Response.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to delete field";
			const status = /not found/i.test(message) ? 404 : 500;
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

	const fieldExists = duckdbQueryOnFile<{ cnt: number }>(dbFile,
		`SELECT COUNT(*) as cnt FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(objectId)}'`,
	);
	if (!fieldExists[0] || fieldExists[0].cnt === 0) {
		return Response.json(
			{ error: "Field not found" },
			{ status: 404 },
		);
	}

	const ok1 = duckdbExecOnFile(dbFile,
		`DELETE FROM entry_fields WHERE field_id = '${sqlEscape(fieldId)}'`,
	);
	const ok2 = duckdbExecOnFile(dbFile,
		`DELETE FROM fields WHERE id = '${sqlEscape(fieldId)}'`,
	);

	if (!ok1 || !ok2) {
		return Response.json(
			{ error: "Failed to delete field" },
			{ status: 500 },
		);
	}

	regeneratePivotView(dbFile, name, objectId);
	updateObjectYamlFields(name, dbFile, objectId);

	return Response.json({ ok: true });
}

/* ─── Shared helpers ─── */

function normalizeEnumValues(value: unknown): string[] | null {
	if (!Array.isArray(value)) {
		return null;
	}
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") {
			return null;
		}
		const trimmed = item.trim();
		if (!trimmed) {
			continue;
		}
		const key = trimmed.toLocaleLowerCase();
		if (seen.has(key)) {
			return null;
		}
		seen.add(key);
		normalized.push(trimmed);
	}
	return normalized;
}

function getEnumValueChanges(
	currentJson: string | null,
	nextValues: string[],
): { added: string[]; removed: string[]; currentLength: number } {
	if (!currentJson) {
		return { added: nextValues, removed: [], currentLength: 0 };
	}
	let currentValues: unknown;
	try {
		currentValues = JSON.parse(currentJson);
	} catch {
		return { added: nextValues, removed: [], currentLength: 0 };
	}
	if (!Array.isArray(currentValues)) {
		return { added: nextValues, removed: [], currentLength: 0 };
	}
	const currentStrings = currentValues.filter((value): value is string => typeof value === "string");
	const nextSet = new Set(nextValues);
	const currentSet = new Set(currentStrings);
	return {
		added: nextValues.filter((value) => !currentSet.has(value)),
		removed: currentStrings.filter((value) => !nextSet.has(value)),
		currentLength: currentStrings.length,
	};
}

function regeneratePivotView(dbFile: string, objectName: string, objectId: string) {
	const fields = duckdbQueryOnFile<{ name: string }>(
		dbFile,
		`SELECT name FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND type != 'action' ORDER BY sort_order`,
	);

	const viewIdent = pivotViewIdentifier(objectName);

	if (fields.length === 0) {
		duckdbExecOnFile(dbFile, `DROP VIEW IF EXISTS ${viewIdent}`);
		return;
	}

	const fieldList = fields.map((f) => `'${sqlEscape(f.name)}'`).join(", ");

	duckdbExecOnFile(
		dbFile,
		`CREATE OR REPLACE VIEW ${viewIdent} AS
		 PIVOT (
		   SELECT e.id as entry_id, e.created_at, e.updated_at,
		          f.name as field_name, ef.value
		   FROM entries e
		   JOIN entry_fields ef ON ef.entry_id = e.id
		   JOIN fields f ON f.id = ef.field_id
		   WHERE e.object_id = '${sqlEscape(objectId)}'
		 ) ON field_name IN (${fieldList}) USING first(value)`,
	);
}

function updateObjectYamlFields(objectName: string, dbFile: string, objectId: string) {
	const dir = findObjectDir(objectName);
	if (!dir) return;

	const existing = readObjectYaml(dir) ?? {};

	const fields = duckdbQueryOnFile<{
		name: string;
		type: string;
		required: boolean;
		enum_values: string | null;
		default_value: string | null;
		sort_order: number;
	}>(
		dbFile,
		`SELECT name, type, required, enum_values, default_value, sort_order FROM fields WHERE object_id = '${sqlEscape(objectId)}' ORDER BY sort_order`,
	);

	const entryCount = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt FROM entries WHERE object_id = '${sqlEscape(objectId)}'`,
	);

	writeObjectYaml(dir, {
		...existing,
		entry_count: entryCount[0]?.cnt ?? 0,
		fields: fields.map((f) => {
			const result: Record<string, unknown> = {
				name: f.name,
				type: f.type,
			};
			if (f.required) result.required = true;
			if (f.enum_values) {
				try { result.enum_values = JSON.parse(f.enum_values); } catch { /* ignore */ }
			}
			if (f.type === "action" && f.default_value) {
				try { result.action_config = JSON.parse(f.default_value); } catch { /* ignore */ }
			}
			return result;
		}),
	});
}
