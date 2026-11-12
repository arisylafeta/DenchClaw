import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { getOffer } from "@/lib/crm-postgres/bulk-offers";
import { prepareOfferSheet, storeOfferSheet } from "@/lib/crm-postgres/bulk-offer-close";
import { SheetRefused } from "@/lib/bulk-price-sheet";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; offerId: string }> };

/**
 * Makes a price sheet for a buyer and stores it with the deal's documents: `overview` (this lot and the buyer's other
 * live, priced lots) or `fixed` (this offer's confirmed line). The send copy is made with the offer email, not here.
 * Nothing is sent. A refusal (409) says what to fix: the seller's quote, the buyer price or the quantity.
 */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  const { id, offerId } = await params;
  const body = await readJson(req) as { kind?: unknown } | null;
  if (body?.kind !== "overview" && body?.kind !== "fixed") {
    return badRequest("Ask for an overview or a fixed price sheet.");
  }
  if (!await getListing(id)) { return notFound("Listing"); }
  const offer = await getOffer(id, offerId, guard.userId);
  if (!offer) { return notFound("Offer"); }
  try {
    const prepared = await prepareOfferSheet(offerId, body.kind);
    const documentId = await storeOfferSheet(offer.listing_id, offerId, prepared, guard.userId);
    return Response.json({
      reference: prepared.sheet.reference, documentId, lines: prepared.lines, total: prepared.sheet.total, skipped: prepared.skipped,
      file: `/api/bulk-listings/${encodeURIComponent(offer.listing_id)}/documents/${encodeURIComponent(documentId)}/file`,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof SheetRefused) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
