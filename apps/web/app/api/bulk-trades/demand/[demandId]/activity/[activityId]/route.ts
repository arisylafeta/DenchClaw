import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { DELETE as listingDELETE } from "@/app/api/bulk-listings/[id]/activity/[activityId]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: Promise<{ demandId: string; activityId: string }> }) {
  const { demandId, ...rest } = await params;
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  if (!await getDemand(demandId)) return notFound("Demand");
  return listingDELETE(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
