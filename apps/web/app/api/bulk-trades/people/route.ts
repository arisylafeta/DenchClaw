import { searchPeople } from "@/lib/crm-postgres/bulk-trade-details";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/bulk-trades/people?q=fen — CRM people to link a trade buyer to. */
export async function GET(req: Request) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return Response.json({ people: [] });
  return Response.json({ people: await searchPeople(query.slice(0, 80)) });
}
