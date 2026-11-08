import { supplyMatchesV2 } from "@/lib/crm-postgres/supply-matches-v2";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The Matches tab on a supply listing: the product key, the live demand it can fill and the ranked buyers. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const result = await supplyMatchesV2((await params).id);
  return result ? Response.json(result) : notFound("Supply listing");
}
