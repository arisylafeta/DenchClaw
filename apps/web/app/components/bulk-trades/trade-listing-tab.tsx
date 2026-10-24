"use client";

import { todayInLondon } from "@/lib/bulk-trades";
import { ListingDetail } from "./listing-detail";

/** One listing in its own workspace tab. The tab title follows the listing once it loads. */
export function TradeListingTab({ listingId, onOpenListing, onClose, onTitle }: {
  listingId: string; onOpenListing: (id: string) => void; onClose: () => void; onTitle: (title: string) => void;
}) {
  return (
    <div className="bulk-trades bt-preview h-full overflow-auto px-2 pb-3 pt-2">
      <ListingDetail key={listingId} id={listingId} today={todayInLondon()} onClose={onClose}
        onOpenListing={onOpenListing} onLoaded={(listing) => onTitle(listing.title)} />
    </div>
  );
}
