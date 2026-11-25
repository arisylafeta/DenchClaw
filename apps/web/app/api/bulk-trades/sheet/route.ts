import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listAbandoned, listSheet } from "@/lib/crm-postgres/bulk-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The working sheet: open demand, open offers and live trades, one row each; plus the Deals board's Abandoned cards. */
export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const [rows, abandoned] = await Promise.all([listSheet(), listAbandoned()]);
  return Response.json({ rows, abandoned });
}
