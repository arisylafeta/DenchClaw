import { listingView } from "@/lib/crm-postgres/bulk-listings";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const listing = await listingView((await params).id);
  return listing ? Response.json({ listing }) : notFound("Listing");
}
