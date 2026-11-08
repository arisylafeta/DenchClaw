"use client";

import { MatchesTab } from "./matches-list";

/**
 * The Matches tab on a supply listing: one ranked list of who could take this lot, with Add to offers and Not a fit.
 * The list itself is shared with the request side.
 */
export function SupplyMatchesTab({ listingId, active, onOpenOffers }: {
  listingId: string; active: boolean; onOpenOffers?: () => void;
}) {
  return <MatchesTab kind="supply" id={listingId} active={active} onOpenOffers={onOpenOffers} />;
}
