import { duckdbQueryAsync } from "@/lib/workspace";
import { postgresReadOnlyQuery } from "@/lib/crm-postgres/sql-execution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BLOCKED_PATTERN =
  /^\s*(DROP\s+DATABASE|ATTACH|DETACH|COPY|EXPORT|INSTALL|LOAD|PRAGMA|\.)/i;

export async function POST(req: Request) {
  let body: { sql?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { sql } = body;
  if (!sql || typeof sql !== "string") {
    return Response.json(
      { error: "Missing 'sql' field in request body" },
      { status: 400 },
    );
  }

  if (BLOCKED_PATTERN.test(sql)) {
    return Response.json(
      { error: "This SQL statement is not allowed" },
      { status: 403 },
    );
  }

  try {
    const rows = process.env.CRM_DB_BACKEND === "postgres"
      ? await postgresReadOnlyQuery(sql)
      : await duckdbQueryAsync(sql);
    return Response.json({ rows: rows ?? [], ok: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Query failed" },
      { status: 500 },
    );
  }
}
