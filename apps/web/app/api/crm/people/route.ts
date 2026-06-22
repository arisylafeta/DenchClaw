import { getPostgresPeople } from "@/lib/crm-postgres/people";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/crm/people?limit=12
 *
 * Lightweight list endpoint used by surfaces that need a small "top N"
 * roster of contacts. Backed by Postgres.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get("limit") ?? "12");
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;

  const data = await getPostgresPeople({ limit });
  return Response.json(data);
}
