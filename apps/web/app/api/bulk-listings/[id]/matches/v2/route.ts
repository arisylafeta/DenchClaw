import { supplyMatchesV2 } from "@/lib/crm-postgres/supply-matches-v2";
import { REASON_MAX, recordSupplyVerdict } from "@/lib/crm-postgres/supply-matches";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The Matches tab on a supply listing: the product key and one ranked list of buyers and live asks. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const result = await supplyMatchesV2((await params).id);
  return result ? Response.json(result) : notFound("Supply listing");
}

/**
 * Not a fit for one row, with a short reason. Kept as Supply activity on the listing, in the same store the phase 2
 * verdicts use, so the row stays hidden on reload and the reason shows in History.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const { id } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.key !== "string" || !/^(demand|company):/.test(body.key)) return badRequest("Which match?");
  if (typeof body.label !== "string" || !body.label.trim()) return badRequest("Which match?");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return badRequest("Say briefly why it is not a fit.");
  if (reason.length > REASON_MAX) return badRequest(`Keep the reason under ${REASON_MAX} characters.`);
  const matches = await supplyMatchesV2(id);
  if (!matches) return notFound("Supply listing");
  if (!matches.rows.some((row) => row.key === body.key)) return notFound("Match");
  return linkedWrite(async () => Response.json({ activity: await recordSupplyVerdict(id, {
    key: body.key as string, verdict: "not_a_fit", label: body.label as string, reason,
  }, guard.userId) }, { status: 201 }));
}
