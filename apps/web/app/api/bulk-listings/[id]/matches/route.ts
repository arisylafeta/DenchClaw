import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { recordSupplyVerdict, supplyMatches } from "@/lib/crm-postgres/supply-matches";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** The live demand that fits this supply listing, scored with the same Exact / Check checks the demand side uses. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const result = await supplyMatches((await params).id);
  return result ? Response.json(result) : notFound("Supply listing");
}

const VERDICTS = ["shortlist", "not_a_fit", "clear"] as const;

/** Shortlist, Not a fit or Clear for one demand. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.demandId !== "string" || !body.demandId) return badRequest("Which demand?");
  if (!(VERDICTS as readonly unknown[]).includes(body.verdict)) return badRequest("Invalid verdict.");
  if (body.note != null && typeof body.note !== "string") return badRequest("note must be text.");
  const demand = await getDemand(body.demandId);
  if (!demand) return notFound("Demand");
  if (!await supplyMatches(id)) return notFound("Supply listing");
  return linkedWrite(async () => Response.json({ activity: await recordSupplyVerdict(id, {
    demandId: demand.id, verdict: body.verdict as (typeof VERDICTS)[number], buyer: demand.buyer, note: body.note as string | null,
  }, guard.userId) }, { status: 201 }));
}
