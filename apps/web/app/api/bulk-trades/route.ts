import { currentUser } from "@/lib/auth";
import { parseTradePatch } from "@/lib/bulk-trades";
import { createBulkTrade, listBulkTrades } from "@/lib/crm-postgres/bulk-trades";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function postgresOnly(): Response | null {
  return process.env.CRM_DB_BACKEND === "postgres"
    ? null
    : Response.json({ error: "Bulk Trades requires the Postgres backend" }, { status: 503 });
}

export async function GET() {
  const unavailable = postgresOnly();
  if (unavailable) return unavailable;
  if (!(await currentUser())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await listBulkTrades());
}

export async function POST(req: Request) {
  const unavailable = postgresOnly();
  if (unavailable) return unavailable;
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = parseTradePatch(await req.json().catch(() => null));
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const { title } = parsed.patch;
  if (!title) return Response.json({ error: "title is required." }, { status: 400 });

  const trade = await createBulkTrade({ ...parsed.patch, title }, user.id);
  return Response.json({ trade }, { status: 201 });
}
