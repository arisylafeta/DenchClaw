"use client";

import { useState } from "react";
import { auctionOfferLabel, shortDate, type AuctionActivity, type TradeAuction } from "@/lib/bulk-trade-details";
import { Card, ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

type Props = {
  tradeId: string;
  auction: TradeAuction;
  today: string;
  onChanged: () => void;
};

const day = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "");

/** Buyer name for someone added from the auction list: the email's company part. */
function nameFromEmail(email: string) {
  const company = email.split("@")[1]?.split(".")[0] ?? email;
  return company.charAt(0).toUpperCase() + company.slice(1);
}

/**
 * The trade's marketplace auction: when it closes, how many people were invited, looked and bid,
 * and the full list behind "See everyone". People who engaged are on the buyer list already.
 */
export function AuctionCard({ tradeId, auction, today, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { people } = auction;
  const closes = auction.closes_at.slice(0, 10);
  const state = auction.status === "withdrawn" ? "Withdrawn" : closes < today ? `Closed ${day(closes)}` : `Open · closes ${day(closes)}`;
  const offers = people.filter((person) => person.last_offer);
  const best = offers
    .map((person) => person.last_offer!)
    .filter((offer) => offer.kind === "offer" && offer.price_per_kwh)
    .sort((a, b) => b.price_per_kwh! - a.price_per_kwh!)[0];
  const counts: [string, number][] = [
    ["Invited", people.filter((person) => person.invited_at).length],
    ["Clicked", people.filter((person) => person.clicked_at).length],
    ["Viewed", people.filter((person) => person.view_count).length],
    ["Offers", offers.length],
  ];

  async function addBuyer(person: AuctionActivity) {
    setAdding(person.email);
    setError(null);
    try {
      await request(tradeUrl(tradeId, "/buyers"), {
        method: "POST",
        body: JSON.stringify({ name: nameFromEmail(person.email), contact: person.email }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add.");
    } finally {
      setAdding(null);
    }
  }

  return (
    <Card label="Auction">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <h2 className="text-[15px] font-semibold">Auction</h2>
        <span className="rounded-none border px-[7px] py-px text-xs font-medium"
          style={closes >= today && auction.status === "published"
            ? { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" }
            : { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" }}>
          {state}
        </span>
        <span className="bt-mono text-[13px]" style={{ color: "var(--bt-text-2)" }}>
          {counts.map(([label, n]) => `${label} ${n}`).join(" · ")}
          {best && ` · Best ${auctionOfferLabel(best)}`}
        </span>
        <span className="flex-1" />
        <a href={auction.url} target="_blank" rel="noreferrer" className={`${buttonClass} inline-flex h-8 items-center`} style={buttonStyle}>
          Open auction page
        </a>
        {people.length > 0 && (
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${buttonClass} h-8`} style={buttonStyle}>
            {open ? "Hide people" : `See everyone (${people.length})`}
          </button>
        )}
      </div>
      {error && <div className="px-5 pb-2"><ErrorText error={error} /></div>}
      {open && (
        <div className="overflow-x-auto border-t" style={{ borderColor: "var(--bt-divider)" }}>
          <table className="w-full min-w-[720px] text-sm">
            <thead style={{ background: "var(--bt-table-head)" }}>
              <tr className="bt-label text-left">
                <th className="px-5 py-2 font-normal">Email</th>
                <th className="px-3 py-2 font-normal">Invited</th>
                <th className="px-3 py-2 font-normal">Clicked</th>
                <th className="px-3 py-2 font-normal">Viewed</th>
                <th className="px-3 py-2 font-normal">Offer</th>
                <th className="px-5 py-2 font-normal" />
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr key={person.email} className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
                  <td className="px-5 py-2">{person.email}</td>
                  <td className="px-3 py-2" style={{ color: "var(--bt-muted)" }}>{day(person.invited_at)}</td>
                  <td className="px-3 py-2" style={{ color: "var(--bt-muted)" }}>{day(person.clicked_at)}</td>
                  <td className="px-3 py-2" style={{ color: "var(--bt-muted)" }}>
                    {person.view_count ? `${person.view_count}× · ${day(person.last_viewed_at)}` : ""}
                  </td>
                  <td className="bt-mono px-3 py-2">{person.last_offer ? auctionOfferLabel(person.last_offer) : person.message_count ? "Message" : ""}</td>
                  <td className="px-5 py-2 text-right">
                    {person.buyer_id
                      ? <span className="text-xs" style={{ color: "var(--bt-muted)" }}>On buyers</span>
                      : (
                        <button type="button" disabled={adding === person.email} onClick={() => addBuyer(person)}
                          className={`${buttonClass} h-7 text-xs`} style={buttonStyle}>
                          Add to buyers
                        </button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
