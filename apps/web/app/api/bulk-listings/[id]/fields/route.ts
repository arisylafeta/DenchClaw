import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { listingFields } from "@/lib/crm-postgres/bulk-trade-details";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  return Response.json({ fields: await listingFields(id) });
}
