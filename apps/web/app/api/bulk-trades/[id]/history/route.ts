import { getBulkTrade } from "@/lib/crm-postgres/bulk-trades";
import { requestHistoryPass } from "@/lib/crm-postgres/bulk-trade-proposals";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Starts a one-off pass over the trade's past emails and calls. Findings arrive as proposals. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!(await getBulkTrade(id))) return notFound("Trade");
  return (await requestHistoryPass(id))
    ? Response.json({ started: true }, { status: 202 })
    : Response.json({ error: "Already reading this trade's emails." }, { status: 409 });
}
