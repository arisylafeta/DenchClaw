import { listingReservations } from "@/lib/crm-postgres/bulk-matches";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** Live reservations held against one supply listing, for its card. Out-of-date ones are not counted. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  return Response.json(await listingReservations((await params).id));
}
