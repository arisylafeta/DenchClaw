import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listSheet } from "@/lib/crm-postgres/bulk-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The working sheet: open demand, open offers and live trades, one row each. */
export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  return Response.json({ rows: await listSheet() });
}
