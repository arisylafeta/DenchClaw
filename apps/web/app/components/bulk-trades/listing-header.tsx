"use client";

import { useState } from "react";
import { ArrowLeft, MoreHorizontal } from "lucide-react";
import { request } from "./trade-ui";
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
  const [menu, setMenu] = useState<"closed" | "menu" | "confirm">("closed");
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  async function remove() {
    setRemoving(true); setRemoveError(null);
    try { await request(`/api/bulk-listings/${encodeURIComponent(listing.id)}/remove`, { method: "POST" }); onBack(); }
    catch (err) { setRemoveError(err instanceof Error ? err.message : "Could not remove it."); setRemoving(false); }
  }
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
      {listing.status !== "closed" && <div className="relative shrink-0">
        <button type="button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menu !== "closed"} onClick={() => setMenu(menu === "closed" ? "menu" : "closed")} className="rounded-md p-1.5 hover:bg-black/5"><MoreHorizontal size={18} aria-hidden /></button>
        {menu !== "closed" && <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border bg-white p-1 text-[13px] shadow-lg" style={{ borderColor: "var(--bt-border, #e5e5e0)" }}>
          {menu === "menu" ? <button type="button" role="menuitem" className="w-full rounded-md px-3 py-2 text-left hover:bg-black/5" onClick={() => setMenu("confirm")}>Remove as bulk trade</button>
            : <div className="p-2"><p className="font-medium">Remove this as a bulk trade?</p>
              <p className="mt-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>It is closed as not a fit and leaves the lists. The record and history stay, and it can be reopened.</p>
              {removeError && <p role="alert" className="mt-1 text-[12px]" style={{ color: "var(--bt-red)" }}>{removeError}</p>}
              <div className="mt-2 flex justify-end gap-2"><button type="button" disabled={removing} className="rounded-md px-2 py-1 hover:bg-black/5" onClick={() => setMenu("closed")}>Cancel</button>
                <button type="button" disabled={removing} className="rounded-md bg-black px-2 py-1 text-white" onClick={() => void remove()}>{removing ? "Removing…" : "Yes, remove"}</button></div></div>}
        </div>}
      </div>}
    </div>
    <div className={css.controls} data-deal-controls>{listing.waiting_on && <WaitingBadge row={listing} />}<OwnerPicker listingId={listing.id} owner={listing.context.owner} onChanged={onChanged} /><FeeInput listingId={listing.id} fee={listing.context.fee_eur} defaultFee={valueAndFee(listing.kind, listing.spec).fee_eur} onChanged={onChanged} /><LikelihoodPicker listingId={listing.id} likelihood={listing.context.likelihood} onChanged={onChanged} /></div>
    <dl className={css.facts}>{[
      ["Seller", listing.party], ["Quantity", listing.quantity], ["Location", listing.location],
      ["Started", shortDate((listing.observed_on ?? listing.created_at).slice(0, 10))],
    ].map(([label, value]) => <div key={label} className={css.fact}><dt>{label}</dt><dd className={value ? undefined : css.quiet}>{value || "Not recorded"}</dd></div>)}</dl>
    {description && <div className={css.brief} data-open={open}><p>{long && !open ? `${words.slice(0, 42).join(" ")}…` : description}</p>
      {long && <button type="button" aria-expanded={open} className={css.more} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
    </div>}
  </header>;
}
