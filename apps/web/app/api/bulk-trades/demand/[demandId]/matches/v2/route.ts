import { demandMatchesV2 } from "@/lib/crm-postgres/demand-matches-v2";
import { guardBulkTrades, notFound } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** The Matches tab on a request: where we can get it, from our listings, the marketplace and unlisted stock. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const result = await demandMatchesV2((await params).demandId);
  return result ? Response.json(result) : notFound("Request");
}
