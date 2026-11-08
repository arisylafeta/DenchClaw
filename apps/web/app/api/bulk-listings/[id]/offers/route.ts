import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { chaseOffers } from "@/lib/crm-postgres/bulk-offer-mail";
import { OFFER_STAGES, OfferConflict, addOffer, listOffers, type OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { badRequest, guardBulkTrades, linkedWrite, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  if (!await getListing(id)) return notFound("Listing");
  const [offers, chase] = await Promise.all([listOffers(id, guard.userId), chaseOffers(id)]);
  // Chase is worked out when the list is read: an offered offer, one unanswered email, three working days.
  const due = new Set(chase.map((row) => row.offerId));
  return Response.json({ offers: offers.map((offer) => ({ ...offer, chase_due: due.has(offer.id) })) });
}

export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id } = await params;
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) return badRequest("Who is this offer for?");
  for (const key of ["contact", "personId", "companyId", "wants", "counterpartId"]) if (body[key] != null && typeof body[key] !== "string") return badRequest(`${key} must be text.`);
  if (body.stage != null && !(OFFER_STAGES as readonly unknown[]).includes(body.stage)) return badRequest("Invalid stage.");
  if (body.data != null && (typeof body.data !== "object" || Array.isArray(body.data))) return badRequest("data must be an object.");
  if (body.source != null && body.source !== "match" && body.source !== "manual") { return badRequest("Unknown offer source."); }
  // A matched row always carries the CRM company or person it stands for. Without one there is nothing to guard the
  // offer against a second row, so the answer is to link the company, not to store an unguarded offer. Only the
  // Offers tab's own "New offer" form makes an offer from a typed name, and it says so.
  if (!body.companyId && !body.personId && body.source !== "manual") { return badRequest("Link this company in the CRM first."); }
  if (!await getListing(id)) return notFound("Listing");
  return linkedWrite(async () => {
    try {
      return Response.json({ offer: await addOffer(id, {
        name: body.name as string, contact: body.contact as string | undefined, personId: body.personId as string | undefined,
        companyId: body.companyId as string | undefined, wants: body.wants as string | undefined, stage: body.stage as OfferStage | undefined,
        counterpartId: body.counterpartId as string | undefined, data: body.data as Record<string, unknown> | undefined,
      }) }, { status: 201 });
    } catch (err) {
      if (err instanceof OfferConflict) return Response.json({ error: err.message, offerId: err.existingOfferId ?? null }, { status: 409 });
      throw err;
    }
  });
}
