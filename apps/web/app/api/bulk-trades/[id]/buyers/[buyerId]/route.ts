import { parseBuyerInput } from "@/lib/bulk-trade-details";
import { updateBuyer } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; buyerId: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseBuyerInput(await readJson(req), false);
  if ("error" in parsed) return badRequest(parsed.error);
  const { id, buyerId } = await params;
  const buyer = await updateBuyer(id, buyerId, parsed.value, guard.userId);
  return buyer ? Response.json({ buyer }) : notFound("Buyer");
}
