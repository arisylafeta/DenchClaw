import { getDemand } from "@/lib/crm-postgres/bulk-demand";
import { OFFER_STAGES, addOffer, listOffers, type OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string }> };

export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId } = await params;
  if (!await getDemand(demandId)) return notFound("Demand");
  return Response.json({ offers: await listOffers(demandId) });
}

export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) return badRequest("Who is this offer for?");
  for (const key of ["contact", "personId", "companyId", "wants"]) if (body[key] != null && typeof body[key] !== "string") return badRequest(`${key} must be text.`);
  if (body.stage != null && !(OFFER_STAGES as readonly unknown[]).includes(body.stage)) return badRequest("Invalid stage.");
  if (!await getDemand(demandId)) return notFound("Demand");
  return linkedWrite(async () => Response.json({ offer: await addOffer(demandId, {
    name: body.name as string, contact: body.contact as string | undefined, personId: body.personId as string | undefined,
    companyId: body.companyId as string | undefined, wants: body.wants as string | undefined, stage: body.stage as OfferStage | undefined,
  }) }, { status: 201 }));
}
