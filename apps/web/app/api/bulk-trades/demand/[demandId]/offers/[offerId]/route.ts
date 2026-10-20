import { OFFER_STAGES, addThreadEntry, getOffer, offerThread, updateOffer, type OfferPatch, type OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ demandId: string; offerId: string }> };
const KINDS = ["note", "call", "quote", "mail", "whatsapp"] as const;

export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId, offerId } = await params;
  const offer = await getOffer(demandId, offerId);
  if (!offer) return notFound("Offer");
  return Response.json({ offer, thread: await offerThread(offer, guard.userId) });
}

export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId, offerId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body) return badRequest("Invalid request.");
  const patch: OfferPatch = {};
  if ("stage" in body) { if (!(OFFER_STAGES as readonly unknown[]).includes(body.stage)) return badRequest("Invalid stage."); patch.stage = body.stage as OfferStage; }
  for (const key of ["nextStep", "nextDue", "wants", "declinedReason"] as const) {
    if (key in body) { if (body[key] != null && typeof body[key] !== "string") return badRequest(`${key} must be text.`); patch[key] = (body[key] as string | null) || null; }
  }
  if ("nextDue" in body && patch.nextDue && !/^\d{4}-\d{2}-\d{2}$/.test(patch.nextDue)) return badRequest("Use a date like 2026-10-30.");
  if ("terms" in body) { if (!body.terms || typeof body.terms !== "object" || Array.isArray(body.terms)) return badRequest("Terms must be an object."); patch.terms = body.terms as OfferPatch["terms"]; }
  const offer = await updateOffer(demandId, offerId, patch, guard.userId);
  return offer ? Response.json({ offer }) : notFound("Offer");
}

/** Add a note, call or message to the thread. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { demandId, offerId } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || !(KINDS as readonly unknown[]).includes(body.kind)) return badRequest("Invalid entry kind.");
  if (typeof body.title !== "string" || !body.title.trim()) return badRequest("Write something first.");
  if (body.body != null && typeof body.body !== "string") return badRequest("Body must be text.");
  const offer = await getOffer(demandId, offerId);
  if (!offer) return notFound("Offer");
  await addThreadEntry(demandId, offer, { kind: body.kind as typeof KINDS[number], title: body.title, body: body.body as string | undefined }, guard.userId);
  return Response.json({ offer: await getOffer(demandId, offerId), thread: await offerThread((await getOffer(demandId, offerId))!, guard.userId) }, { status: 201 });
}
