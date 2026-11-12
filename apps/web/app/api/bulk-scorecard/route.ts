import { loadScorecard } from "@/lib/crm-postgres/bulk-scorecard";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The scorecard for the last full week and the quarter to date (docs/bulk-relay-system/scorecard.md). Read only. */
export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  return Response.json(await loadScorecard());
}
