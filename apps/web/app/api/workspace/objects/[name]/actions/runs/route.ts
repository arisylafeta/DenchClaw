import { requiresIsolatedPostgres } from "@/lib/crm-postgres/user-scope";
import { duckdbQueryOnFile, findDuckDBForObject } from "@/lib/workspace";
import { getPostgresActionRuns } from "@/lib/crm-postgres/actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

/**
 * GET /api/workspace/objects/[name]/actions/runs
 * Fetch recent action runs.
 * Query: ?fieldId=&entryId=&actionId=&limit=
 */
export async function GET(
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
	const url = new URL(req.url);
	const fieldId = url.searchParams.get("fieldId");
	const entryId = url.searchParams.get("entryId");
	const actionId = url.searchParams.get("actionId");
	const limit = Math.min(Number(url.searchParams.get("limit") || "20"), 100);

	if (process.env.CRM_DB_BACKEND === "postgres") {
		const runs = await getPostgresActionRuns(name, {
			fieldId,
			entryId,
			actionId,
			limit,
		});
		return Response.json({ runs });
	}

	const dbFile = findDuckDBForObject(name);
	if (!dbFile) {
		return Response.json({ error: "DuckDB not found" }, { status: 404 });
	}

	try {
		const hasTable = duckdbQueryOnFile<{ cnt: number }>(
			dbFile,
			"SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_name = 'action_runs'",
		);
		if (!hasTable[0]?.cnt) {
			return Response.json({ runs: [] });
		}
	} catch {
		return Response.json({ runs: [] });
	}

	const conditions: string[] = [];
	if (fieldId) conditions.push(`field_id = '${sqlEscape(fieldId)}'`);
	if (entryId) conditions.push(`entry_id = '${sqlEscape(entryId)}'`);
	if (actionId) conditions.push(`action_id = '${sqlEscape(actionId)}'`);

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	try {
		const runs = duckdbQueryOnFile<{
			id: string;
			action_id: string;
			field_id: string;
			entry_id: string;
			status: string;
			started_at: string;
			completed_at: string | null;
			result: string | null;
			error: string | null;
			exit_code: number | null;
		}>(
			dbFile,
			`SELECT id, action_id, field_id, entry_id, status, started_at, completed_at, result, error, exit_code
			 FROM action_runs ${whereClause}
			 ORDER BY started_at DESC
			 LIMIT ${limit}`,
		);

		return Response.json({ runs });
	} catch {
		return Response.json({ runs: [] });
	}
}
