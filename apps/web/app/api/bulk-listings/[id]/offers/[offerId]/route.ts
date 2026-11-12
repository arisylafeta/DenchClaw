import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { markNoStock } from "@/lib/crm-postgres/bulk-offer-mail";
import { OFFER_STAGES, OfferConflict, addThreadEntry, getOffer, linkOffer, offerThread, updateOffer, type OfferPatch, type OfferStage } from "@/lib/crm-postgres/bulk-offers";
import { badRequest, guardBulkTrades, notFound, readJson } from "@/lib/bulk-trades-route";
import { missingPaidFacts, missingPaidMessage, readPaidFacts } from "@/lib/bulk-offer-paid";
import { offerClose, offerGate } from "@/lib/crm-postgres/bulk-offer-close";
import { expiryProblem, priceUnit, stepGaps } from "@/lib/bulk-offer-close";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; offerId: string }> };
const KINDS = ["note", "call", "quote", "mail", "whatsapp"] as const;

export async function GET(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, offerId } = await params;
  if (!await getListing(id)) return notFound("Listing");
  const offer = await getOffer(id, offerId, guard.userId);
  if (!offer) return notFound("Offer");
  // `close`: the quote gate, the offer's last day, its quantity and (staff only, never sent) the margin.
  const [thread, close] = await Promise.all([offerThread(offer, guard.userId), offerClose(offerId)]);
  return Response.json({ offer, thread, close });
}

/** Checks the offer's terms: a buyer price is a positive amount in a known currency, per a unit, with an optional date. */
function readTerms(raw: unknown): OfferPatch["terms"] | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Terms must be an object.";
  const terms = { ...(raw as Record<string, unknown>) };
  if (terms.amount != null) {
    const amount = typeof terms.amount === "string" ? Number(terms.amount) : terms.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return "The price must be a number above 0.";
    terms.amount = amount;
    if (typeof terms.currency !== "string" || !/^[A-Za-z]{3}$/.test(terms.currency)) return "Give the price's currency, like GBP.";
    terms.currency = terms.currency.toUpperCase();
    if (typeof terms.unit !== "string" || !terms.unit.trim()) return "Say what the price is per, like pack or kWh.";
  }
  for (const key of ["unit", "currency", "firmness", "delivery_terms", "payment_terms", "expires_on"]) {
    if (terms[key] != null && typeof terms[key] !== "string") return `${key} must be text.`;
    if (terms[key] === "") delete terms[key];
  }
  if (typeof terms.unit === "string" && terms.amount != null && !priceUnit(terms.unit) && !["kg", "lot", "tonne"].includes(terms.unit.trim().toLowerCase())) {
    return "Price per pack, module, cell, unit, kWh, MWh, kg, tonne or lot.";
  }
  return terms as OfferPatch["terms"];
}

export async function PATCH(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, offerId } = await params;
  const listing = await getListing(id);
  if (!listing) return notFound("Listing");
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body) return badRequest("Invalid request.");
  const patch: OfferPatch = {};
  if ("stage" in body) { if (!(OFFER_STAGES as readonly unknown[]).includes(body.stage)) return badRequest("Invalid stage."); patch.stage = body.stage as OfferStage; }
  for (const key of ["nextStep", "nextDue", "wants", "declinedReason"] as const) {
    if (key in body) { if (body[key] != null && typeof body[key] !== "string") return badRequest(`${key} must be text.`); patch[key] = (body[key] as string | null) || null; }
  }
  if ("nextDue" in body && patch.nextDue && !/^\d{4}-\d{2}-\d{2}$/.test(patch.nextDue)) return badRequest("Use a date like 2026-10-30.");
  // A lost or declined offer is only useful with the reason: it feeds what we learn about the buyer.
  if (patch.stage === "declined" || patch.stage === "lost") {
    const reason = patch.declinedReason?.trim() ?? "";
    if (!reason) { return badRequest(`Give a short reason for ${patch.stage === "declined" ? "Declined" : "Lost"}.`); }
    if (reason.length > 500) { return badRequest("Keep the reason under 500 characters."); }
    patch.declinedReason = reason;
  }
  if ("terms" in body) {
    const terms = readTerms(body.terms);
    if (typeof terms === "string") return badRequest(terms);
    // To a buyer, the offer may not outlast the seller's quote, and its last day defaults to the quote's.
    const gated = await offerGate(offerId);
    if (gated?.side === "buyer") {
      const problem = expiryProblem(terms?.expires_on, gated.gate);
      if (problem) return badRequest(problem);
      if (terms && !terms.expires_on && gated.gate?.ok) terms.expires_on = gated.gate.validUntil;
    }
    patch.terms = terms;
  }
  const paid = readPaidFacts(body);
  if (typeof paid === "string") return badRequest(paid);
  if (Object.keys(paid).length) patch.paid = paid;
  // The card's gates, held here too so no caller skips them. To a buyer, Offered only while the seller's quote is
  // confirmed and in date (the same check as Draft email and the send). Contract sent, Signed and Invoice sent only with
  // a buyer price, a quantity and a valid-until date (stepGaps, as the card reads them).
  if (patch.stage) {
    const current = await getOffer(id, offerId, guard.userId);
    if (!current) return notFound("Offer");
    if (patch.stage !== current.stage) {
      if (patch.stage === "offered") {
        const gated = await offerGate(offerId);
        if (gated?.side === "buyer" && !gated.gate?.ok) {
          const reason = gated.gate && !gated.gate.ok ? gated.gate.reason : "The seller's quote could not be read. Ask them to confirm it.";
          return Response.json({ error: reason, blocked: "seller_quote", reconfirm: true }, { status: 409 });
        }
      }
      const close = await offerClose(offerId);
      const terms = patch.terms ?? current.terms ?? {};
      const quantity = patch.paid && "quantity" in patch.paid ? patch.paid.quantity ?? null : current.quantity;
      const gaps = stepGaps(patch.stage, { terms: { ...terms, expires_on: terms.expires_on ?? close?.expiresOn ?? undefined }, quantity: quantity ?? close?.quantity ?? null });
      if (gaps.length) return badRequest(`Add the ${gaps.join(", ")} first.`);
    }
  }
  // Paid and Complete need the paid facts, so bulk take is counted from what was really paid. Checked against what the
  // offer already holds, whenever the stage or a paid fact changes.
  if ("stage" in patch || patch.paid) {
    const current = await getOffer(id, offerId, guard.userId);
    if (!current) return notFound("Offer");
    const stage = patch.stage ?? current.stage;
    const missing = missingPaidFacts(stage, { ...current, ...patch.paid });
    if (stage && missing.length) return Response.json({ error: missingPaidMessage(stage, missing), missing }, { status: 400 });
  }
  if ("counterpartId" in body) {
    if (body.counterpartId != null && typeof body.counterpartId !== "string") return badRequest("counterpartId must be text or null.");
    try { if (!await linkOffer(id, offerId, (body.counterpartId as string | null) || null, guard.userId)) return notFound("Offer"); }
    catch (err) { if (err instanceof OfferConflict) return Response.json({ error: err.message, offerId: err.existingOfferId ?? null }, { status: 409 }); throw err; }
  }
  const offer = await updateOffer(id, offerId, patch, guard.userId);
  if (!offer) return notFound("Offer");
  // "No stock" from a supplier means the stock line we asked about is gone at its source. Exactly that row
  // is marked stale; on a listing it only suggests closing the listing, which a person still decides.
  if (offer.stage === "declined" || offer.stage === "lost") {
    if ((offer.declined_reason ?? "").trim().toLowerCase() === "no stock") {
      const noStock = await markNoStock(id, offerId, listing.kind === "demand" ? "demand" : "supply", guard.userId);
      return Response.json({ offer, noStock });
    }
  }
  return Response.json({ offer });
}

/** Add a note, call or message to the thread. */
export async function POST(req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) return guard.response;
  const { id, offerId } = await params;
  const listing = await getListing(id);
  if (!listing) return notFound("Listing");
  const body = await readJson(req) as Record<string, unknown> | null;
  if (!body || !(KINDS as readonly unknown[]).includes(body.kind)) return badRequest("Invalid entry kind.");
  if (typeof body.title !== "string" || !body.title.trim()) return badRequest("Write something first.");
  if (body.body != null && typeof body.body !== "string") return badRequest("Body must be text.");
  const offer = await getOffer(id, offerId, guard.userId);
  if (!offer) return notFound("Offer");
  await addThreadEntry(id, offer, { kind: body.kind as typeof KINDS[number], title: body.title, body: body.body as string | undefined }, guard.userId);
  return Response.json({ offer: await getOffer(id, offerId, guard.userId), thread: await offerThread((await getOffer(id, offerId, guard.userId))!, guard.userId) }, { status: 201 });
}
