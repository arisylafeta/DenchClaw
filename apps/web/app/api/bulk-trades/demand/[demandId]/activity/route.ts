import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { GET as listingGET, POST as listingPOST } from "@/app/api/bulk-listings/[id]/activity/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const { demandId, ...rest } = await params;
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  if (!await getDemand(demandId)) return notFound("Demand");
  return listingGET(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}

export async function POST(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const { demandId, ...rest } = await params;
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  if (!await getDemand(demandId)) return notFound("Demand");
  return listingPOST(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
