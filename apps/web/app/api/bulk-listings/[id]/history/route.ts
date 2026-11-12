import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { dealHistory } from "@/lib/crm-postgres/bulk-history";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The deal's email and WhatsApp messages as one readable thread, oldest first: only what its links point to. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  return Response.json({ messages: await dealHistory(id, guard.userId) });
}
