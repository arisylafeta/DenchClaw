import { parseTradePatch } from "@/lib/bulk-trades";
import { updateBulkTrade } from "@/lib/crm-postgres/bulk-trades";
import { getTradeDetail } from "@/lib/crm-postgres/bulk-trade-details";
import { historyStatus, tradeProposals } from "@/lib/crm-postgres/bulk-trade-proposals";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";
import { trackedLinkBase } from "@/lib/tracked-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const [detail, proposals, history] = await Promise.all([getTradeDetail(id), tradeProposals(id), historyStatus(id)]);
  return detail ? Response.json({ ...detail, proposals, history, link_tracking: trackedLinkBase() !== null }) : notFound("Trade");
}

export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseTradePatch(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const { id } = await params;
  return linkedWrite(async () => {
    const trade = await updateBulkTrade(id, parsed.patch, guard.userId);
    return trade ? Response.json({ trade }) : notFound("Trade");
  });
}
