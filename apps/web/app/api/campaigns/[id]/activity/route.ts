import { getCampaignActivity } from "@/lib/campaign-activity-server";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const guard = await guardBulkTrades("Campaign activity");
  if ("response" in guard) { return guard.response; }
  const activity = await getCampaignActivity((await params).id);
  return activity ? Response.json(activity, { headers: { "Cache-Control": "private, no-store" } }) : notFound("Campaign");
}
