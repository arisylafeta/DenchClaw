"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { BulkListingView } from "@/lib/bulk-listing";
import { shortDate } from "@/lib/bulk-trade-details";
import { LikelihoodPicker } from "./likelihood-picker";
import { OwnerPicker } from "./owner-picker";
import { FeeInput } from "./fee-input";
import { valueAndFee } from "@/lib/bulk-sheet";
import { CopyIdButton } from "./copy-id-button";
import { WaitingBadge } from "./opportunities-sheet";
import css from "./demand-header.module.css";

export function ListingHeader({ listing, onBack, onChanged }: { listing: BulkListingView; onBack: () => void; onChanged?: () => void }) {
  const [open, setOpen] = useState(false);
  const description = [listing.summary, listing.note].filter(Boolean).join("\n\n");
  const words = description.split(/\s+/);
  const long = words.length > 42;
  return <header className={css.root}>
    <button type="button" onClick={onBack} className={css.back}><ArrowLeft size={13} aria-hidden /> Bulk Trades</button>
    <div className={css.titleRow}>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1"><h2 className={css.title}>{listing.title}</h2><CopyIdButton id={listing.id} className="mt-1" /></div>
        <div className={css.sub}><span>{listing.party}</span><span className={css.chip}>{listing.status === "closed" ? "closed" : listing.stage}</span>
          {listing.context.priority === true && <span className={`${css.chip} ${css.chipGreen}`}>Priority</span>}
          {listing.is_trade && <span className={`${css.chip} ${css.chipGreen}`}>TRADE</span>}
        </div>
      </div>
      <div className={`${css.status} flex items-start gap-2`}>{listing.waiting_on && <WaitingBadge row={listing} large />}<FeeInput listingId={listing.id} fee={listing.context.fee_eur} defaultFee={valueAndFee(listing.kind, listing.spec).fee_eur} onChanged={onChanged} /><LikelihoodPicker listingId={listing.id} likelihood={listing.context.likelihood} onChanged={onChanged} /><OwnerPicker listingId={listing.id} owner={listing.context.owner} onChanged={onChanged} /></div>
    </div>
    <dl className={css.facts}>{[
      ["Seller", listing.party], ["Quantity", listing.quantity], ["Location", listing.location],
      ["Started", shortDate((listing.observed_on ?? listing.created_at).slice(0, 10))],
    ].map(([label, value]) => <div key={label} className={css.fact}><dt>{label}</dt><dd className={value ? undefined : css.quiet}>{value || "Not recorded"}</dd></div>)}</dl>
    {description && <div className={css.brief} data-open={open}><p>{long && !open ? `${words.slice(0, 42).join(" ")}…` : description}</p>
      {long && <button type="button" aria-expanded={open} className={css.more} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
    </div>}
  </header>;
}
