import { guardBulkTrades } from "@/lib/bulk-trades-route";
import { loadRegistry } from "@/lib/crm-postgres/bulk-registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The attribute registry (trade fields per kind, buyer-ask lists, units, required files), read from the database. */
export async function GET() {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  return Response.json({ registry: await loadRegistry() });
}
