import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { getPlan } from "@/lib/crm-postgres/marketplace-pulse";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One saved version of the growth plan. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades("Marketplace Pulse");
  if ("response" in guard) return guard.response;
  const plan = await getPlan((await params).id);
  return plan ? Response.json({ plan }) : notFound("Plan version");
}
