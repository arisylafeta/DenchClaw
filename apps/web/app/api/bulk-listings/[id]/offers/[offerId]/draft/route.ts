import { ALLOWED_EMAILS, currentUser } from "@/lib/auth";
import { getListing } from "@/lib/crm-postgres/bulk-listings";
import { offerOutreach, setOpenDraft } from "@/lib/crm-postgres/bulk-offer-mail";
import { readMailDraft } from "@/lib/crm-postgres/mail";
import { buildOfferEmail, OfferEmailRefused, type OfferEmailKind } from "@/lib/match/offer-email";
import { createOfferEmailDraft, OfferDraftError } from "@/lib/match/offer-draft";
import { badRequest, guardBulkTrades, notFound } from "@/lib/bulk-trades-route";
import { offerGate, prepareOfferSheet, storeOfferSheet, type PreparedSheet } from "@/lib/crm-postgres/bulk-offer-close";
import { SheetRefused } from "@/lib/bulk-price-sheet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; offerId: string }> };

/** Chase only while offered; otherwise the side's first email decides the shape. */
function kindFor(stage: string | null, chase: boolean, kind: "supply" | "demand"): OfferEmailKind {
  if (stage === "offered" && chase) {
    return "chase";
  }
  return kind === "supply" ? "supply_offer" : "request_stock";
}

/**
 * Prepares one offer email as a draft. The copy is built from the offer, the listing and the buyer's dossier
 * only. One open draft per offer: while the stored draft is still unsent, the same one comes back.
 *
 * To a buyer (an offer on a supply listing), only while the seller's quote is confirmed and in date: otherwise 409 with
 * the reason and `reconfirm: true`, so the card offers the seller re-confirm draft. With a buyer price and a quantity on
 * the offer, the email carries the fixed price sheet's lines and the sheet itself is stored as the send copy. Drafts to
 * sellers are never gated.
 */
export async function POST(_req: Request, { params }: Context) {
  const guard = await guardBulkTrades();
  if ("response" in guard) { return guard.response; }
  // The draft is written in Alex's voice and signed by him, so it takes the same allow-list as the send. Read-only
  // access to the tab is not enough to put words in his mouth.
  const user = await currentUser();
  if (!user) { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  if (!ALLOWED_EMAILS.has(user.email.toLowerCase())) {
    return Response.json({ error: "Only Ari or Alex can create offer drafts." }, { status: 403 });
  }
  const { id, offerId } = await params;
  if (!await getListing(id)) { return notFound("Listing"); }
  const outreach = await offerOutreach(id, offerId);
  if (!outreach) { return notFound("Offer"); }
  if (outreach.stage !== "candidate" && outreach.stage !== "offered") {
    return badRequest("Draft an email only while the offer is a candidate or offered.");
  }
  if (outreach.blocked || !outreach.email) {
    return Response.json({ error: outreach.blocked ?? "This offer has no email address." }, { status: 409 });
  }
  const kind = kindFor(outreach.stage, outreach.chaseDue, outreach.kind);
  if (outreach.kind === "supply") {
    const gated = await offerGate(offerId);
    if (!gated?.gate?.ok) {
      const reason = gated?.gate && !gated.gate.ok ? gated.gate.reason : "The seller's quote could not be read. Ask them to confirm it.";
      return Response.json({ error: reason, blocked: "seller_quote", reconfirm: true }, { status: 409 });
    }
  }

  if (outreach.openDraftId) {
    const open = await readMailDraft(outreach.openDraftId, guard.userId);
    if (open && open.state === "draft") {
      return Response.json({ draftId: open.id, kind, subject: open.subject, body: open.body_text, reused: true });
    }
    // The stored draft was sent or deleted: drop the pointer rather than open a second copy of it.
    await setOpenDraft(offerId, null);
  }

  // The send copy: built before the email so its lines go in the body, stored only once the draft exists.
  let sheet: PreparedSheet | null = null;
  const terms = (outreach.terms ?? {}) as { amount?: number; currency?: string; unit?: string };
  if (kind === "supply_offer" && terms.amount != null && terms.currency && terms.unit && outreach.quantity != null) {
    try {
      sheet = await prepareOfferSheet(offerId, "send");
    } catch (error) {
      if (error instanceof SheetRefused) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
  }

  let email;
  try {
    email = buildOfferEmail({
      kind,
      key: outreach.product.key,
      fields: outreach.product.fields,
      recipientFirstName: outreach.recipientFirstName,
      location: outreach.location,
      buyer: outreach.buyer,
      request: outreach.request ?? null,
      side: outreach.kind,
      previousSubject: outreach.lastSent?.subject ?? null,
      privateValues: outreach.privateValues,
      priceLines: sheet?.sheet.text ?? null,
    });
  } catch (error) {
    if (error instanceof OfferEmailRefused) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  try {
    const draftId = await createOfferEmailDraft({ to: [outreach.email], subject: email.subject, body: email.body });
    await setOpenDraft(offerId, draftId);
    const sheetDocumentId = sheet ? await storeOfferSheet(id, offerId, sheet, guard.userId, draftId) : null;
    return Response.json({
      draftId, kind: email.kind, subject: email.subject, body: email.body, reused: false,
      sheet: sheet ? { reference: sheet.sheet.reference, documentId: sheetDocumentId } : null,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof OfferDraftError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
