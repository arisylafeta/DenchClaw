import { GET as listingGET, POST as listingPOST } from "@/app/api/bulk-listings/[id]/activity/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingGET(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}

export async function POST(req: Request, { params }: { params: Promise<{ demandId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingPOST(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
