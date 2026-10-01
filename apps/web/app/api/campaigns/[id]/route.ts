import { getCampaignDetail } from "@/lib/crm-postgres/campaigns";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades("Campaigns");
  if ("response" in guard) { return guard.response; }
  const detail = await getCampaignDetail((await params).id);
  return detail ? Response.json(detail) : notFound("Campaign");
}
