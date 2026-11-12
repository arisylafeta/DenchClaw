import "server-only";
import { ladder, nextStep, priceLine, priceMoves, stageHint, whoseMove, type OfferSide, type Position, type PriceLine, type StageHint, type Step } from "./bulk-offer-position-core";
import { recentMessages, type Offer } from "./crm-postgres/bulk-offers";

/** What an offer row shows besides the offer itself: whose move, the next step, the price, how far it has got, a stage to confirm. */
export type OfferPosition = Omit<Position, "next"> & {
  side: OfferSide;
  next: string | null;
  price: PriceLine | null;
  moves: { at: string; who: string; text: string }[];
  steps: Step[];
  hint: StageHint | null;
  /** The channel of the newest message, so the row can say where to answer. */
  last_channel: "mail" | "whatsapp" | null;
};

type ListingParty = { kind: string; party: string; company_id: string | null; person_id: string | null };

/**
 * Which side the other party is on. An offer from another listing takes that listing's side. On this listing, the
 * listing's own party (the buyer on a demand, the seller on a supply) is that side; everyone else is the other one.
 */
export function sideOf(offer: Offer, listing: ListingParty): OfferSide {
  if (offer.incoming) return offer.from_kind === "supply" ? "seller" : "buyer";
  const own = (!!listing.company_id && offer.company_id === listing.company_id) || (!!listing.person_id && offer.person_id === listing.person_id)
    || (offer.name ?? "").trim().toLowerCase() === listing.party.trim().toLowerCase();
  const demand = listing.kind === "demand";
  return own === demand ? "buyer" : "seller";
}

/** Where each offer stands, worked out from its newest messages. */
export async function offerPositions(offers: Offer[], listing: ListingParty, now = new Date()): Promise<Map<string, OfferPosition>> {
  const messages = await recentMessages(offers.map((o) => o.id));
  const out = new Map<string, OfferPosition>();
  for (const offer of offers) {
    const mine = messages.get(offer.id) ?? [];
    const side = sideOf(offer, listing);
    const override = offer.waiting_on && offer.waiting_set_at ? { who: offer.waiting_on, at: offer.waiting_set_at } : null;
    const saved = !override && offer.waiting_on ? { who: offer.waiting_on, since: offer.waiting_since ? `${offer.waiting_since.slice(0, 10)}T12:00:00Z` : null } : null;
    const position = whoseMove({ stage: offer.stage, messages: mine, override, saved, chaseOffAt: offer.chase_off_at, now });
    const newest = [...mine].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
    out.set(offer.id, {
      ...position,
      side,
      next: nextStep({ text: offer.next_step, at: offer.next_step_at }, position, newest?.at ?? null),
      price: priceLine(offer.terms as Record<string, unknown>, side),
      moves: priceMoves(offer.terms as Record<string, unknown>, side),
      steps: ladder({ stage: offer.stage, terms: offer.terms as Record<string, unknown>, side, contacted: mine.some((m) => m.direction === "outbound") }),
      hint: stageHint({ stage: offer.stage, messages: mine, skipped: offer.stage_hint_skip }),
      last_channel: newest?.channel ?? null,
    });
  }
  return out;
}
