import { listCampaigns } from "@/lib/crm-postgres/campaigns";
import { guardBulkTrades } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const guard = await guardBulkTrades("Campaigns");
  if ("response" in guard) { return guard.response; }
  return Response.json({ campaigns: await listCampaigns() });
}
