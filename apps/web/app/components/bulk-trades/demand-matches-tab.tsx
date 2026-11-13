"use client";

import { MatchesTab } from "./matches-list";

/** The Matches tab on a request: where to get it, one ranked list across our listings, the marketplace and stock. */
export function DemandMatchesTab({ demandId, active, onOpenOffers, onOpenDetails }: {
  demandId: string; active: boolean; onOpenOffers?: () => void; onOpenDetails?: () => void;
}) {
  return <MatchesTab kind="demand" id={demandId} active={active} onOpenOffers={onOpenOffers} onOpenDetails={onOpenDetails} />;
}
