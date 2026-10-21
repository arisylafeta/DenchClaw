"use client";

// Temporary integration seam. Replaced by the listing-detail implementation at merge.
export function ListingDetail({ id, onClose }: { id: string; today: string; onClose: () => void; onOpenListing: (id: string) => void }) {
  return <section><button type="button" onClick={onClose}>Back</button><p>Listing {id}</p></section>;
}
