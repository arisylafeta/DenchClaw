import { parseTradePatch } from "@/lib/bulk-trades";
import { updateBulkTrade } from "@/lib/crm-postgres/bulk-trades";
import { getTradeDetail } from "@/lib/crm-postgres/bulk-trade-details";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { trackedLinkBase } from "@/lib/tracked-links";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const detail = await getTradeDetail((await params).id);
  return detail ? Response.json({ ...detail, link_tracking: trackedLinkBase() !== null }) : notFound("Trade");
}

export async function PATCH(req: Request, { params }: Params) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const parsed = parseTradePatch(await readJson(req));
  if ("error" in parsed) return badRequest(parsed.error);
  const trade = await updateBulkTrade((await params).id, parsed.patch, guard.userId);
  return trade ? Response.json({ trade }) : notFound("Trade");
}
