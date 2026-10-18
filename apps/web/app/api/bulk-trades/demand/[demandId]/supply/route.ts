import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { demandSupply, recordMatchVerdict } from "@/lib/crm-postgres/demand-supply";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

/** Our inventory scored against this demand row: marketplace listings, stock lists, trades and supply. */
export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const demand = await getDemand((await params).demandId);
  if (!demand) return notFound("Demand");
  return Response.json(await demandSupply(demand));
}

const VERDICTS = ["shortlist", "not_a_fit", "clear"] as const;

/** Shortlist, Not a fit or Clear for one unit. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.key !== "string" || !/^(listing|stock|trade|supply):/.test(body.key)) return badRequest("Invalid unit.");
  if (!(VERDICTS as readonly unknown[]).includes(body.verdict)) return badRequest("Invalid verdict.");
  if (typeof body.title !== "string" || !body.title.trim()) return badRequest("Title is required.");
  for (const key of ["seller", "note", "href"] as const) {
    if (body[key] != null && typeof body[key] !== "string") return badRequest(`${key} must be text.`);
  }
  if (body.eurPerKwh != null && (typeof body.eurPerKwh !== "number" || !Number.isFinite(body.eurPerKwh))) return badRequest("Invalid price.");
  if (!await getDemand(demandId)) return notFound("Demand");
  return linkedWrite(async () => Response.json({ activity: await recordMatchVerdict(demandId, {
    key: body.key as string, verdict: body.verdict as (typeof VERDICTS)[number], title: (body.title as string).trim(),
    seller: body.seller as string | null, note: body.note as string | null, eurPerKwh: body.eurPerKwh as number | null,
    href: body.href as string | null,
  }, guard.userId) }, { status: 201 }));
}
