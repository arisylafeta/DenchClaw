import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { listingConversation } from "@/lib/crm-postgres/bulk-thread-links";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** The labelled conversation with the buyer (email and WhatsApp), or null when no thread is labelled for this demand yet. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId } = await params;
  if (!await getDemand(demandId)) return notFound("Demand");
  return Response.json({ conversation: await listingConversation(demandId, guard.userId) });
}
