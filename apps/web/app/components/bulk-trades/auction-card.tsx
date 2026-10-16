"use client";

import { useState } from "react";
import { auctionOfferLabel, type AuctionActivity } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

export function auctionStatus(person: AuctionActivity): string {
  return person.last_offer ? "Offer" : person.view_count ? "Viewed" : person.message_count ? "Messaged" : person.clicked_at ? "Clicked" : person.invited_at ? "Invited" : "—";
}

export function AuctionRow({ tradeId, person, columns, onChanged }: {
  tradeId: string; person: AuctionActivity; columns: string; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function add() {
    setBusy(true);
    setError(null);
    try {
      const company = person.email.split("@")[1]?.split(".")[0] ?? person.email;
      await request(tradeUrl(tradeId, "/buyers"), { method: "POST", body: JSON.stringify({ name: company, contact: person.email }) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add buyer.");
    } finally { setBusy(false); }
  }
  return <div data-table-part="grid-row" className={`grid ${columns} items-center gap-3.5 border-b px-3 py-2 text-xs`} style={{ borderColor: "var(--bt-divider)" }}>
    <span /><span className="truncate" title={person.email}>{person.email}</span><span>—</span>
    <span>{auctionStatus(person)}</span><span>—</span><span>—</span>
    <span>{person.last_offer ? auctionOfferLabel(person.last_offer) : "—"}</span>
    <button type="button" disabled={busy} onClick={add} className={`${buttonClass} !h-7`} style={buttonStyle}>Add buyer</button>
    {error && <ErrorText error={error} />}
  </div>;
}
