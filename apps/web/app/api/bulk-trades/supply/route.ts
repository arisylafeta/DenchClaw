import { lastSupplyMatchRun, listSupply } from "@/lib/crm-postgres/bulk-supply";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const [supply, matched] = await Promise.all([listSupply(), lastSupplyMatchRun()]);
  return Response.json({ supply, matched });
}
