import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { listClosed, listSheet } from "@/lib/crm-postgres/bulk-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The working sheet: open demand, open offers and live trades, one row each. `closed` is what was closed in the last 30 days (the Board's Closed column). */
export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const [rows, closed] = await Promise.all([listSheet(), listClosed()]);
  return Response.json({ rows, closed });
}
