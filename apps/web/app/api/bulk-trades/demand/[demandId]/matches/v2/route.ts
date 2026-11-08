import { demandMatchesV2 } from "@/lib/crm-postgres/demand-matches-v2";
import { recordMatchVerdict } from "@/lib/crm-postgres/demand-supply";
import { REASON_MAX } from "@/lib/crm-postgres/supply-matches";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** The Matches tab on a request: where we can get it, one ranked list across every source we hold. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const result = await demandMatchesV2((await params).demandId);
  return result ? Response.json(result) : notFound("Request");
}

/** Not a fit for one unit, with a short reason, kept as Supply activity on the request. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) {
    return guard.response;
  }
  const { demandId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.key !== "string" || !/^(listing|stock|trade|supply):/.test(body.key)) return badRequest("Which match?");
  if (typeof body.label !== "string" || !body.label.trim()) return badRequest("Which match?");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return badRequest("Say briefly why it is not a fit.");
  if (reason.length > REASON_MAX) return badRequest(`Keep the reason under ${REASON_MAX} characters.`);
  const matches = await demandMatchesV2(demandId);
  if (!matches) return notFound("Request");
  if (!matches.rows.some((row) => row.key === body.key)) return notFound("Match");
  return linkedWrite(async () => Response.json({ activity: await recordMatchVerdict(demandId, {
    key: body.key as string, verdict: "not_a_fit", title: body.label as string, reason,
  }, guard.userId) }, { status: 201 }));
}
