import { GET as listingGET, PATCH as listingPATCH, POST as listingPOST } from "@/app/api/bulk-listings/[id]/offers/[offerId]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ demandId: string; offerId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingGET(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ demandId: string; offerId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingPATCH(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}

export async function POST(req: Request, { params }: { params: Promise<{ demandId: string; offerId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingPOST(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
