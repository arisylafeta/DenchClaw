import { bestMatchLines } from "@/lib/crm-postgres/demand-supply";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The best inventory match per open demand row, for the Demand list. */
export async function GET(req: Request) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  return Response.json({ matches: await bestMatchLines(new URL(req.url).searchParams.has("fresh")) });
}
