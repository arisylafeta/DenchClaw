import { requiresIsolatedPostgres } from "@/lib/crm-postgres/user-scope";
import {
	duckdbExecOnFile,
	duckdbQueryOnFile,
	findDuckDBForObject,
	resolveWorkspaceRoot,
	duckdbPath,
} from "@/lib/workspace";
import { runActionScript, runBulkAction, type ActionConfig, type ActionContext, type ActionEvent } from "@/lib/action-runner";
import {
	getPostgresActionConfig,
	getPostgresActionContexts,
	persistPostgresActionRun,
} from "@/lib/crm-postgres/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

type FieldRow = {
	id: string;
	name: string;
	type: string;
	default_value: string | null;
};

function parseActionConfig(defaultValue: string | null): ActionConfig[] {
	if (!defaultValue) return [];
	try {
		const parsed = JSON.parse(defaultValue);
		if (parsed && Array.isArray(parsed.actions)) return parsed.actions;
	} catch { /* ignore */ }
	return [];
}

/**
 * POST /api/workspace/objects/[name]/actions
 * Execute an action on one or more entries. Returns SSE stream.
 * Body: { actionId: string, fieldId: string, entryIds: string[] }
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
	const body = await req.json();
	const { actionId, fieldId, entryIds } = body as {
		actionId: string;
		fieldId: string;
		entryIds: string[];
	};

	if (!actionId || !fieldId || !Array.isArray(entryIds) || entryIds.length === 0) {
		return Response.json({ error: "actionId, fieldId, and entryIds[] required" }, { status: 400 });
	}

	const postgresMode = process.env.CRM_DB_BACKEND === "postgres";
	const dbFile = postgresMode ? "" : findDuckDBForObject(name);
	if (!dbFile) {
		if (postgresMode) {
			// no-op (handled below)
		} else {
		return Response.json({ error: "DuckDB not found" }, { status: 404 });
		}
	}
	const actionDbFile = dbFile || "";

	if (postgresMode) {
		const cfg = await getPostgresActionConfig(name, fieldId, actionId);
		if (!cfg) {
			return Response.json({ error: `Action '${actionId}' not found on field` }, { status: 404 });
		}
		const contexts = await getPostgresActionContexts(name, entryIds);
		const normalizedContexts = contexts.map((ctx) => ({
			...ctx,
			actionId,
			fieldId,
			objectName: name,
			objectId: cfg.objectId,
		}));
		return streamActionExecution(cfg.action, normalizedContexts, {
			actionId,
			fieldId,
			objectId: cfg.objectId,
			persist: (run) => persistPostgresActionRun(run),
		});
	}

	const field = duckdbQueryOnFile<FieldRow>(
		actionDbFile,
		`SELECT id, name, type, default_value FROM fields WHERE id = '${sqlEscape(fieldId)}' AND type = 'action' LIMIT 1`,
	);
	if (field.length === 0) {
		return Response.json({ error: "Action field not found" }, { status: 404 });
	}

	const actions = parseActionConfig(field[0].default_value);
	const action = actions.find((a) => a.id === actionId);
	if (!action) {
		return Response.json({ error: `Action '${actionId}' not found on field` }, { status: 404 });
	}

	const objects = duckdbQueryOnFile<{ id: string }>(
		actionDbFile,
		`SELECT id FROM objects WHERE name = '${sqlEscape(name)}' LIMIT 1`,
	);
	if (objects.length === 0) {
		return Response.json({ error: "Object not found" }, { status: 404 });
	}
	const objectId = objects[0].id;

	const workspacePath = resolveWorkspaceRoot() ?? "";
	const dbPath = duckdbPath() ?? "";
	const port = process.env.PORT || "3000";
	const apiUrl = `http://localhost:${port}/api`;

	const allFields = duckdbQueryOnFile<{ name: string }>(
		actionDbFile,
		`SELECT name FROM fields WHERE object_id = '${sqlEscape(objectId)}' AND type != 'action' ORDER BY sort_order`,
	);
	const fieldNames = allFields.map((f) => f.name);

	const contexts: ActionContext[] = [];
	for (const entryId of entryIds) {
		let entryData: Record<string, unknown> = {};
		try {
			const rows = duckdbQueryOnFile<Record<string, unknown>>(
				actionDbFile,
				`SELECT ef.value, f.name as field_name
				 FROM entry_fields ef JOIN fields f ON f.id = ef.field_id
				 WHERE ef.entry_id = '${sqlEscape(entryId)}'`,
			);
			for (const row of rows) {
				if (row.field_name) entryData[String(row.field_name)] = row.value;
			}
			entryData.entry_id = entryId;
		} catch { /* entry data fetch failed, provide minimal context */ }

		contexts.push({
			entryId,
			entryData,
			objectName: name,
			objectId,
			actionId,
			fieldId,
			workspacePath,
			dbPath,
			apiUrl,
		});
	}

	return streamActionExecution(action, contexts, {
		actionId,
		fieldId,
		objectId,
		persist: (run) => {
			persistActionRun(actionDbFile, run);
		},
	});
}

function streamActionExecution(
	action: ActionConfig,
	contexts: ActionContext[],
	meta: {
		actionId: string;
		fieldId: string;
		objectId: string;
		persist: (run: {
			actionId: string;
			fieldId: string;
			entryId: string;
			objectId: string;
			status: string;
			result: string | null;
			error: string | null;
			exitCode: number | null;
		}) => void | Promise<void>;
	},
) {
	const runIdPrefix = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		async start(controller) {
			function sendEvent(event: ActionEvent) {
				const data = JSON.stringify(event);
				controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));

				if (event.type === "completed") {
					void meta.persist({
						actionId: meta.actionId,
						fieldId: meta.fieldId,
						entryId: event.entryId,
						objectId: meta.objectId,
						status: event.status,
						result: event.result ? JSON.stringify(event.result) : null,
						error: event.error ?? null,
						exitCode: event.exitCode ?? null,
					});
				}
			}

			try {
				const gen = contexts.length === 1
					? runActionScript(action, contexts[0], `${runIdPrefix}_0`)
					: runBulkAction(action, contexts, runIdPrefix);

				for await (const event of gen) {
					sendEvent(event);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`));
			} finally {
				controller.close();
			}
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

function persistActionRun(dbFile: string, run: {
	actionId: string;
	fieldId: string;
	entryId: string;
	objectId: string;
	status: string;
	result: string | null;
	error: string | null;
	exitCode: number | null;
}) {
	try {
		const hasTable = duckdbQueryOnFile<{ cnt: number }>(
			dbFile,
			"SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = 'action_runs'",
		);
		if (!hasTable[0]?.cnt) {
			duckdbExecOnFile(dbFile, `CREATE TABLE IF NOT EXISTS action_runs (
				id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
				action_id VARCHAR NOT NULL,
				field_id VARCHAR NOT NULL,
				entry_id VARCHAR NOT NULL,
				object_id VARCHAR NOT NULL,
				status VARCHAR NOT NULL DEFAULT 'pending',
				started_at TIMESTAMPTZ DEFAULT now(),
				completed_at TIMESTAMPTZ,
				result VARCHAR,
				error VARCHAR,
				stdout VARCHAR,
				exit_code INTEGER
			)`);
		}

		duckdbExecOnFile(dbFile, `INSERT INTO action_runs (action_id, field_id, entry_id, object_id, status, completed_at, result, error, exit_code)
			VALUES (
				'${sqlEscape(run.actionId)}',
				'${sqlEscape(run.fieldId)}',
				'${sqlEscape(run.entryId)}',
				'${sqlEscape(run.objectId)}',
				'${sqlEscape(run.status)}',
				now(),
				${run.result ? `'${sqlEscape(run.result)}'` : "NULL"},
				${run.error ? `'${sqlEscape(run.error)}'` : "NULL"},
				${run.exitCode !== null ? run.exitCode : "NULL"}
			)`);
	} catch { /* best-effort persistence */ }
}
