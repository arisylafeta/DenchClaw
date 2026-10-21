import { GET as listingGET } from "@/app/api/bulk-listings/[id]/conversation/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingGET(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
