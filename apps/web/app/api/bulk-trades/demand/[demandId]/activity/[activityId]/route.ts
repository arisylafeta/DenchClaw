import { DELETE as listingDELETE } from "@/app/api/bulk-listings/[id]/activity/[activityId]/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: Request, { params }: { params: Promise<{ demandId: string; activityId: string }> }) {
  const { demandId, ...rest } = await params;
  return listingDELETE(req, { params: Promise.resolve({ id: demandId, ...rest }) });
}
