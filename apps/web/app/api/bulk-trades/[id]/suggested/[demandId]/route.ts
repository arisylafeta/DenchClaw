import { addSuggestedBuyer, hideSuggestion } from "@/lib/crm-postgres/bulk-demand";
import { guardBulkTrades, linkedWrite, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; demandId: string }> };

/** Adds a suggested buyer to the trade's buyers. */
export async function POST(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, demandId } = await params;
  return linkedWrite(async () => {
    const buyer = await addSuggestedBuyer(id, demandId, guard.userId);
    return buyer ? Response.json({ buyer }, { status: 201 }) : notFound("Demand");
  });
}

/** "Not a fit": hides the suggestion on this trade. */
export async function DELETE(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, demandId } = await params;
  return (await hideSuggestion(id, demandId)) ? new Response(null, { status: 204 }) : notFound("Suggestion");
}
