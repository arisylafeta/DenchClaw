import { requiresIsolatedPostgres } from "@/lib/crm-postgres/user-scope";
import {
	duckdbQueryOnFile,
	duckdbExecOnFile,
	findDuckDBForObject,
} from "@/lib/workspace";
import { queryPg } from "@/lib/postgres";
import {
	getIntegrationsState,
	resolveDenchGatewayCredentials,
} from "@/lib/integrations";
import {
	extractDomain,
	extractEnrichmentValue,
	getEnrichmentColumns,
	isEligibleInputField,
	type EnrichmentColumnDef,
} from "@/lib/enrichment-columns";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ENRICHMENT_BASE_PATH = "/v1/enrichment";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

type EnrichRequestBody = {
	fieldId: string;
	apolloPath: string;
	category: "people" | "company";
	inputFieldName: string;
	scope: "all" | "empty" | number;
	/**
	 * Optional explicit list of entry IDs to enrich. When provided, the SQL
	 * scope is narrowed to these entries (intersected with the `scope`
	 * filter, so e.g. `scope: "empty"` + `entryIds: [...]` enriches only
	 * those listed entries that don't already have a value). Used by the
	 * row-selection "Enrich" bulk action so the user can target the rows
	 * they checked instead of the whole table.
	 *
	 * Capped at MAX_ENTRY_IDS to keep the SQL `IN (...)` clause bounded
	 * and to make abuse via huge payloads obvious.
	 */
	entryIds?: string[];
};

const MAX_ENTRY_IDS = 5000;
const ENTRY_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const POSTGRES_OBJECT_TABLES: Record<string, string> = {
	people: "crm_people",
	company: "crm_companies",
	companies: "crm_companies",
	email_thread: "crm_email_threads",
	email_message: "crm_email_messages",
	calendar_event: "crm_calendar_events",
	interaction: "crm_interactions",
};

/**
 * POST /api/workspace/objects/[name]/enrich
 * Enriches entries via Apollo through the ReBattery Cloud gateway.
 * Streams progress as SSE so the frontend can show a waterfall effect.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ name: string }> },
) {
	const { name } = await params;
  if (requiresIsolatedPostgres(name)) {
    return Response.json(
      { error: "Actions are disabled for user-scoped objects." },
      { status: 403 },
    );
  }

	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
		return Response.json({ error: "Invalid object name" }, { status: 400 });
	}

	// --- Gating checks ---
	const state = getIntegrationsState();
	if (!state.denchCloud.isPrimaryProvider) {
		return Response.json({ error: "ReBattery Cloud is not the active provider." }, { status: 403 });
	}
	if (!state.denchCloud.hasKey) {
		return Response.json({ error: "No ReBattery Cloud API key configured." }, { status: 403 });
	}
	const apollo = state.integrations.find((i) => i.id === "apollo");
	if (!apollo?.enabled) {
		return Response.json({ error: "Apollo integration is not enabled." }, { status: 403 });
	}

	const { apiKey, gatewayUrl } = resolveDenchGatewayCredentials();
	if (!apiKey || !gatewayUrl) {
		return Response.json({ error: "Gateway credentials unavailable." }, { status: 500 });
	}

	const body: EnrichRequestBody = await req.json();
	const { fieldId, apolloPath, category, inputFieldName, scope, entryIds } = body;

	if (!fieldId || !apolloPath || !category || !inputFieldName) {
		return Response.json({ error: "Missing required fields." }, { status: 400 });
	}

	if (category !== "people" && category !== "company") {
		return Response.json({ error: "Invalid category." }, { status: 400 });
	}

	// Validate entryIds early so a malformed payload fails fast instead of
	// landing as a SQL error mid-stream. Empty array is treated as "no narrowing"
	// (i.e. fall through to the regular scope filter) so callers don't have to
	// special-case the "no-selection" path on the client.
	let narrowedEntryIds: string[] | undefined;
	if (entryIds !== undefined) {
		if (!Array.isArray(entryIds)) {
			return Response.json({ error: "entryIds must be an array." }, { status: 400 });
		}
		if (entryIds.length > MAX_ENTRY_IDS) {
			return Response.json(
				{ error: `Too many entryIds (max ${MAX_ENTRY_IDS}).` },
				{ status: 400 },
			);
		}
		const cleaned: string[] = [];
		for (const id of entryIds) {
			if (typeof id !== "string" || !ENTRY_ID_PATTERN.test(id)) {
				return Response.json({ error: "Invalid entry ID." }, { status: 400 });
			}
			cleaned.push(id);
		}
		if (cleaned.length > 0) {
			narrowedEntryIds = cleaned;
		}
	}

	// Resolve the canonical column def (for requiredFields + extraction fallbacks).
	// Falls back to a synthetic column when callers pass a custom apolloPath so
	// existing integrations keep working without bypassing extraction.
	const matchedColumn: EnrichmentColumnDef = getEnrichmentColumns(category).find(
		(candidate) => candidate.apolloPath === apolloPath,
	) ?? {
		label: "",
		key: apolloPath,
		fieldType: "text",
		apolloPath,
		// Unknown column: never send a narrowing contract; gateway uses its default
		// backfill list (getRequiredFieldsForApolloPath would yield [] here anyway).
		requiredFields: [],
	};

	if (
		scope !== "all"
		&& scope !== "empty"
		&& (
			typeof scope !== "number"
			|| scope <= 0
			|| !Number.isFinite(scope)
			|| !Number.isInteger(scope)
		)
	) {
		return Response.json({ error: "Invalid scope." }, { status: 400 });
	}

	if (process.env.CRM_DB_BACKEND === "postgres") {
		return enrichWithPostgres({
			name,
			fieldId,
			inputFieldName,
			scope,
			narrowedEntryIds,
			gatewayUrl,
			apiKey,
			category,
			matchedColumn,
		});
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json({ error: "DuckDB not found." }, { status: 404 });
	}

	// Resolve object
	const objects = duckdbQueryOnFile<{ id: string }>(
		dbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json({ error: `Object '${name}' not found.` }, { status: 404 });
	}
	const objectId = objects[0].id;

	// Resolve the input field ID by name
	const inputFields = duckdbQueryOnFile<{ id: string; name: string; type: string }>(
		dbFile,
		`SELECT id, name, type FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND name = '${sqlEscape(inputFieldName)}'`,
	);
	if (inputFields.length === 0) {
		return Response.json({ error: `Input field '${inputFieldName}' not found.` }, { status: 404 });
	}
	if (!isEligibleInputField(category, inputFields[0])) {
		return Response.json({ error: `Input field '${inputFieldName}' is not supported for ${category} enrichment.` }, { status: 400 });
	}
	const inputFieldId = inputFields[0].id;

	// Verify enrichment field exists
	const enrichField = duckdbQueryOnFile<{ id: string }>(
		dbFile,
		`SELECT id FROM fields WHERE id = '${sqlEscape(fieldId)}' AND object_id = '${sqlEscape(objectId)}'`,
	);
	if (enrichField.length === 0) {
		return Response.json({ error: "Enrichment field not found." }, { status: 404 });
	}

	// Load entries with their input values
	let entrySql = `
		SELECT e.id as entry_id, ef.value as input_value
		FROM entries e
		LEFT JOIN entry_fields ef ON ef.entry_id = e.id AND ef.field_id = '${sqlEscape(inputFieldId)}'
		WHERE e.object_id = '${sqlEscape(objectId)}'
	`;

	if (narrowedEntryIds && narrowedEntryIds.length > 0) {
		// Compose with the `scope` filter rather than replacing it: lets
		// callers say "enrich the selected rows that are still empty" when
		// the row selection includes already-enriched entries.
		const inList = narrowedEntryIds.map((id) => `'${sqlEscape(id)}'`).join(",");
		entrySql += ` AND e.id IN (${inList})`;
	}

	if (scope === "empty") {
		entrySql += `
			AND e.id NOT IN (
				SELECT ef2.entry_id FROM entry_fields ef2
				WHERE ef2.field_id = '${sqlEscape(fieldId)}'
				AND ef2.value IS NOT NULL AND ef2.value != ''
			)
		`;
	}

	if (typeof scope === "number" && scope > 0) {
		entrySql += ` LIMIT ${scope}`;
	}

	const entries = duckdbQueryOnFile<{ entry_id: string; input_value: string | null }>(
		dbFile,
		entrySql,
	);

	const total = entries.length;

	// Set up SSE stream
	const encoder = new TextEncoder();
	let cancelled = false;
	const stream = new ReadableStream({
		async start(controller) {
			function send(data: Record<string, unknown>) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			}

			let enriched = 0;
			let failed = 0;

			for (let i = 0; i < entries.length; i++) {
				if (cancelled) break;
				const entry = entries[i];
				const inputValue = entry.input_value?.trim();

				if (!inputValue) {
					failed++;
					send({
						type: "error",
						entryId: entry.entry_id,
						error: "No input value",
						current: i + 1,
						total,
					});
					continue;
				}

				try {
					const result = await callApolloGateway(
						gatewayUrl,
						apiKey,
						category,
						inputValue,
						matchedColumn.requiredFields,
					);
					if (cancelled) break;

					if (!result.ok) {
						failed++;
						send({
							type: "error",
							entryId: entry.entry_id,
							error: result.error,
							current: i + 1,
							total,
						});
						continue;
					}

					const value = extractEnrichmentValue(
						result.payload as Record<string, unknown>,
						matchedColumn,
					);

					if (value == null) {
						failed++;
						send({
							type: "error",
							entryId: entry.entry_id,
							error: "Field not found in response",
							current: i + 1,
							total,
						});
						continue;
					}

					patchEntryField(dbFile, entry.entry_id, fieldId, value);

					enriched++;
					send({
						type: "progress",
						entryId: entry.entry_id,
						value,
						current: i + 1,
						total,
					});
				} catch (err) {
					if (cancelled) break;
					failed++;
					send({
						type: "error",
						entryId: entry.entry_id,
						error: err instanceof Error ? err.message : "Unknown error",
						current: i + 1,
						total,
					});
				}
			}

			if (!cancelled) {
				send({ type: "done", enriched, failed, total });
				controller.close();
			}
		},
		cancel() {
			cancelled = true;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

async function enrichWithPostgres(args: {
	name: string;
	fieldId: string;
	inputFieldName: string;
	scope: "all" | "empty" | number;
	narrowedEntryIds?: string[];
	gatewayUrl: string;
	apiKey: string;
	category: "people" | "company";
	matchedColumn: EnrichmentColumnDef;
}) {
	const { name, fieldId, inputFieldName, scope, narrowedEntryIds, gatewayUrl, apiKey, category, matchedColumn } = args;
	const objectRows = await queryPg<{ id: string }>("select id from crm_objects where name = $1 limit 1", [name]);
	if (!objectRows[0]) return Response.json({ error: `Object '${name}' not found.` }, { status: 404 });
	const objectId = objectRows[0].id;

	const inputFields = await queryPg<{ id: string; name: string; type: string; canonical_column: string | null }>(
		`select id, name, type, canonical_column from crm_fields where object_id = $1 and name = $2 limit 1`,
		[objectId, inputFieldName],
	);
	if (!inputFields[0]) {
		return Response.json({ error: `Input field '${inputFieldName}' not found.` }, { status: 404 });
	}
	if (!isEligibleInputField(category, inputFields[0])) {
		return Response.json({ error: `Input field '${inputFieldName}' is not supported for ${category} enrichment.` }, { status: 400 });
	}

	const enrichFieldRows = await queryPg<{ id: string; canonical_column: string | null; type: string }>(
		"select id, canonical_column, type from crm_fields where object_id = $1 and id = $2 limit 1",
		[objectId, fieldId],
	);
	if (!enrichFieldRows[0]) return Response.json({ error: "Enrichment field not found." }, { status: 404 });

	const tableName = POSTGRES_OBJECT_TABLES[name];
	const inputField = inputFields[0];
	const enrichField = enrichFieldRows[0];

	const entries = await loadPostgresEntriesForEnrichment({
		objectId,
		tableName,
		inputField,
		enrichField,
		scope,
		narrowedEntryIds,
	});
	const total = entries.length;

	const encoder = new TextEncoder();
	let cancelled = false;
	const stream = new ReadableStream({
		async start(controller) {
			function send(data: Record<string, unknown>) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
			}

			let enriched = 0;
			let failed = 0;
			for (let i = 0; i < entries.length; i++) {
				if (cancelled) break;
				const entry = entries[i];
				const inputValue = entry.input_value?.trim();
				if (!inputValue) {
					failed++;
					send({ type: "error", entryId: entry.entry_id, error: "No input value", current: i + 1, total });
					continue;
				}
				try {
					const result = await callApolloGateway(gatewayUrl, apiKey, category, inputValue, matchedColumn.requiredFields);
					if (!result.ok) {
						failed++;
						send({ type: "error", entryId: entry.entry_id, error: result.error, current: i + 1, total });
						continue;
					}
					const value = extractEnrichmentValue(result.payload as Record<string, unknown>, matchedColumn);
					if (value == null) {
						failed++;
						send({ type: "error", entryId: entry.entry_id, error: "Field not found in response", current: i + 1, total });
						continue;
					}
					await patchPostgresEntryField(objectId, entry.entry_id, fieldId, enrichField, value);
					enriched++;
					send({ type: "progress", entryId: entry.entry_id, value, current: i + 1, total });
				} catch (err) {
					failed++;
					send({ type: "error", entryId: entry.entry_id, error: err instanceof Error ? err.message : "Unknown error", current: i + 1, total });
				}
			}
			if (!cancelled) {
				send({ type: "done", enriched, failed, total });
				controller.close();
			}
		},
		cancel() {
			cancelled = true;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

async function loadPostgresEntriesForEnrichment(args: {
	objectId: string;
	tableName?: string;
	inputField: { id: string; canonical_column: string | null };
	enrichField: { id: string; canonical_column: string | null };
	scope: "all" | "empty" | number;
	narrowedEntryIds?: string[];
}): Promise<Array<{ entry_id: string; input_value: string | null }>> {
	const { tableName, inputField, enrichField, scope, narrowedEntryIds } = args;
	if (tableName && inputField.canonical_column) {
		const params: unknown[] = [];
		const where: string[] = [];
		if (narrowedEntryIds?.length) {
			params.push(narrowedEntryIds);
			where.push(`e.id = any($${params.length}::text[])`);
		}
		if (scope === "empty") {
			if (enrichField.canonical_column) {
				where.push(`coalesce(e."${enrichField.canonical_column.replace(/"/g, '""')}"::text, '') = ''`);
			}
		}
		let limitSql = "";
		if (typeof scope === "number" && scope > 0) {
			params.push(scope);
			limitSql = ` limit $${params.length}`;
		}
		const whereSql = where.length ? `where ${where.join(" and ")}` : "";
		return queryPg<{ entry_id: string; input_value: string | null }>(
			`select e.id as entry_id, e."${inputField.canonical_column.replace(/"/g, '""')}"::text as input_value
			 from ${tableName} e
			 ${whereSql}
			${limitSql}`,
			params,
		);
	}

	return [];
}

async function patchPostgresEntryField(
	objectId: string,
	entryId: string,
	fieldId: string,
	field: { canonical_column: string | null; type: string },
	value: string,
) {
	if (!field.canonical_column) {
		throw new Error(`Cannot enrich field without canonical_column (fieldId=${fieldId})`);
	}
	const objects = await queryPg<{ name: string }>("select name from crm_objects where id = $1 limit 1", [objectId]);
	const tableName = POSTGRES_OBJECT_TABLES[objects[0]?.name ?? ""];
	if (!tableName) {
		throw new Error(`No entity table for object (objectId=${objectId})`);
	}
	await queryPg(
		`update ${tableName} set "${field.canonical_column.replace(/"/g, '""')}" = $1, updated_at = now() where id = $2`,
		[value, entryId],
	);
}

type GatewayCallResult =
	| { ok: true; payload: unknown }
	| { ok: false; error: string };

async function callApolloGateway(
	gatewayUrl: string,
	apiKey: string,
	category: "people" | "company",
	inputValue: string,
	requiredFields: string[],
): Promise<GatewayCallResult> {
	if (category === "people") {
		const body: Record<string, unknown> = {};

		if (inputValue.includes("linkedin.com")) {
			body.linkedin_url = inputValue;
		} else if (inputValue.includes("@")) {
			body.email = inputValue;
		} else {
			return { ok: false, error: "Unsupported people identifier" };
		}
		if (requiredFields.length > 0) {
			body.requiredFields = requiredFields;
		}

		const response = await fetch(
			`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
			},
		);

		if (!response.ok) {
			return { ok: false, error: await formatGatewayError(response) };
		}
		return { ok: true, payload: await response.json() };
	}

	const domain = extractDomain(inputValue);
	if (!domain) {
		return { ok: false, error: "Could not extract domain" };
	}

	const url = new URL(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/company`);
	url.searchParams.set("domain", domain);
	if (requiredFields.length > 0) {
		url.searchParams.set("requiredFields", requiredFields.join(","));
	}
	const response = await fetch(url, {
		method: "GET",
		headers: { authorization: `Bearer ${apiKey}` },
	});

	if (!response.ok) {
		return { ok: false, error: await formatGatewayError(response) };
	}
	return { ok: true, payload: await response.json() };
}

async function formatGatewayError(response: Response): Promise<string> {
	let body: unknown = null;
	try {
		body = await response.json();
	} catch {
		// Body not JSON; fall back to status-only messages below.
	}
	const error = (body as { error?: { code?: string; message?: string } } | null)?.error;
	const code = error?.code;
	const message = error?.message;

	if (response.status === 404 || code === "not_found") {
		return "No data returned";
	}
	if (response.status === 503 || code === "provider_unavailable") {
		return "Gateway providers unavailable";
	}
	if (code === "invalid_required_field") {
		return message ?? "Invalid required field";
	}
	if (message) return message;
	return `Gateway request failed (HTTP ${response.status})`;
}

function patchEntryField(
	dbFile: string,
	entryId: string,
	fieldId: string,
	value: string,
) {
	const escapedValue = `'${sqlEscape(value)}'`;

	const existing = duckdbQueryOnFile<{ cnt: number }>(
		dbFile,
		`SELECT COUNT(*) as cnt FROM entry_fields WHERE entry_id = '${sqlEscape(entryId)}' AND field_id = '${sqlEscape(fieldId)}'`,
	);

	if (existing[0]?.cnt > 0) {
		duckdbExecOnFile(
			dbFile,
			`UPDATE entry_fields SET value = ${escapedValue} WHERE entry_id = '${sqlEscape(entryId)}' AND field_id = '${sqlEscape(fieldId)}'`,
		);
	} else {
		duckdbExecOnFile(
			dbFile,
			`INSERT INTO entry_fields (entry_id, field_id, value) VALUES ('${sqlEscape(entryId)}', '${sqlEscape(fieldId)}', ${escapedValue})`,
		);
	}

	const now = new Date().toISOString();
	duckdbExecOnFile(
		dbFile,
		`UPDATE entries SET updated_at = '${now}' WHERE id = '${sqlEscape(entryId)}'`,
	);
}
