"use client";

import { LikelihoodPicker } from "./likelihood-picker";
import { OwnerPicker } from "./owner-picker";
import { FeeInput } from "./fee-input";
import { CantSourceControl } from "./cant-source-control";
import { valueAndFee } from "@/lib/bulk-sheet";
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { BulkListingView } from "@/lib/bulk-listing";
import { Sh } from "./bt-shimmer";
import { ErrorText, sharedGet } from "./trade-ui";
import { PreviewDemandPanel } from "./preview-demand-panel";
import { SupplyListingPanel } from "./supply-listing-panel";

/** One bad listing must not take the whole page down: the URL keeps the listing open, so a render crash would survive every reload. */
class ListingBoundary extends Component<{ id: string; onClose: () => void; children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { failed: error instanceof Error ? error.message : "Unknown error" }; }
  componentDidUpdate(prev: { id: string }) { if (prev.id !== this.props.id && this.state.failed) { this.setState({ failed: null }); } }
  render() {
    if (this.state.failed === null) { return this.props.children; }
    return <div role="alert" className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
      <button type="button" onClick={this.props.onClose} className="w-fit text-[13px] hover:underline" style={{ color: "var(--bt-muted)" }}>← Bulk Trades</button>
      <p className="text-[13px]" style={{ color: "var(--bt-red)" }}>This listing could not be displayed ({this.state.failed}). The record is intact; tell Devon the listing id: {this.props.id}</p>
    </div>;
  }
}

export function ListingDetail(props: Parameters<typeof ListingDetailInner>[0]) {
  return <ListingBoundary id={props.id} onClose={props.onClose}><ListingDetailInner {...props} /></ListingBoundary>;
}

function ListingDetailInner({ id, today, onClose, onOpenListing, onLoaded }: {
  id: string; today: string; onClose: () => void; onOpenListing: (id: string) => void;
  /** Called with the listing once loaded, so a host tab can show its title. */
  onLoaded?: (listing: BulkListingView) => void;
}) {
  const [result, setResult] = useState<{ id: string; listing: BulkListingView | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  const load = useCallback(async () => {
    const seq = ++latest.current;
    setError(null);
    try {
      const data = await sharedGet<{ listing: BulkListingView | null }>(`/api/bulk-listings/${encodeURIComponent(id)}`);
      if (seq === latest.current) { setResult({ id, listing: data.listing }); if (data.listing) loaded.current?.(data.listing); }
    } catch (err) {
      if (seq === latest.current) setError(err instanceof Error ? err.message : "Could not load this listing.");
    }
  }, [id]);
  useEffect(() => { void load(); return () => { latest.current++; }; }, [load]);
  const listing = result?.id === id ? result.listing : null;
  if (listing?.kind === "demand" && listing.demand) return <PreviewDemandPanel key={id} demand={listing.demand} today={today} onChanged={load} onClose={onClose} onOpenTrade={onOpenListing} onOpenSupply={onOpenListing} onOpenDemand={onOpenListing} isTrade={listing.is_trade} waiting={listing} ownerPicker={<><CantSourceControl listingId={listing.id} reason={listing.context.cant_source} onChanged={load} /><FeeInput listingId={listing.id} fee={listing.context.fee_eur} defaultFee={valueAndFee(listing.kind, listing.spec).fee_eur} onChanged={load} /><LikelihoodPicker listingId={listing.id} likelihood={listing.context.likelihood} onChanged={load} /><OwnerPicker listingId={listing.id} owner={listing.context.owner} onChanged={load} /></>} />;
  if (listing?.kind === "supply") return <SupplyListingPanel key={id} listing={listing} today={today} onChanged={load} onClose={onClose} onOpenListing={onOpenListing} />;
  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3">
    <button type="button" onClick={onClose} className="w-fit text-[13px] hover:underline" style={{ color: "var(--bt-muted)" }}>← Bulk Trades</button>
    <ErrorText error={error} />
    {result?.id !== id && !error ? <div role="status" aria-busy="true" className="flex flex-col gap-3 pt-2">
      <span className="sr-only">Loading listing</span><h2 className="text-[20px] font-semibold"><Sh on chars={32} /></h2><p className="text-[13px]"><Sh on chars={48} /></p><p className="text-[13px]"><Sh on chars={64} /></p>
    </div> : <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{!error ? "This listing no longer exists." : ""}</p>}
  </div>;
}
