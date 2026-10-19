"use client";

import { useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import {
  BUYER_STATUSES,
  BUYER_SUBJECT,
  auctionOfferLabel,
  bidLabel,
  greeting,
  shortDate,
  type Buyer,
  type BuyerStatus,
  type Proposal,
  type TradeField,
  type TradeAuction,
} from "@/lib/bulk-trade-details";
import { BidDialog, BuyerDialog, TeaserDialog } from "./buyer-dialogs";
import { EmailDialog } from "./email-dialog";
import { AuctionRow, auctionStatus } from "./auction-card";
import { ProposalRow } from "./proposal-row";
import {
  Card,
  ErrorText,
  buttonClass,
  buttonStyle,
  darkButtonClass,
  darkButtonStyle,
  request,
  tradeUrl,
} from "./trade-ui";

/** Status colour: grey before contact, blue while in play, green once a bid lands, red when declined. */
function statusStyle(status: BuyerStatus): React.CSSProperties {
  const tone = status.startsWith("Declined") ? "red"
    : ["Bid in", "LOI or deposit", "Won"].includes(status) ? "green"
    : ["Teaser sent", "NDA, specs sent"].includes(status) ? "blue" : "grey";
  return {
    red: { background: "var(--bt-red-bg)", color: "var(--bt-red)", borderColor: "var(--bt-red-border)" },
    green: { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" },
    blue: { background: "var(--bt-blue-bg)", color: "var(--bt-blue)", borderColor: "var(--bt-blue-border)" },
    grey: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" },
  }[tone];
}

const COLUMNS = "grid-cols-[24px_minmax(180px,1.3fr)_minmax(140px,1fr)_150px_110px_90px_130px_100px]";

type Props = {
  trade: BulkTrade;
  buyers: Buyer[];
  auction?: TradeAuction | null;
  fields: TradeField[];
  today: string;
  linkTracking: boolean;
  proposals: Proposal[];
  onProposalDecided: () => void;
  onBuyer: (buyer: Buyer) => void;
};

export function BuyersTable({ trade, buyers, auction, fields, today, linkTracking, proposals, onProposalDecided, onBuyer }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Buyer | "new" | null>(null);
  const [bidFor, setBidFor] = useState<Buyer | null>(null);
  const [teaser, setTeaser] = useState(false);
  const [emailing, setEmailing] = useState<Buyer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bids = buyers.filter((buyer) => buyer.latest_bid).length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function changeStatus(buyer: Buyer, status: BuyerStatus) {
    setError(null);
    onBuyer({ ...buyer, status });
    try {
      const saved = await request<{ buyer: Buyer }>(tradeUrl(trade.id, `/buyers/${buyer.id}`), {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      onBuyer(saved.buyer);
    } catch (err) {
      onBuyer(buyer);
      setError(`Could not update ${buyer.name}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  return (
    <Card label="Buyers" className={`bulk-trades ${tableStyles.surface} self-start overflow-hidden`}>
      <header data-table-part="toolbar" className="flex flex-wrap items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--bt-column)" }}>
        <h2 className="text-base font-semibold">Buyers</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
          {buyers.length} {buyers.length === 1 ? "buyer" : "buyers"} · {bids} {bids === 1 ? "bid" : "bids"}
        </span>
        <span className="flex-1" />
        <button type="button" className={`${buttonClass} !h-8`} style={buttonStyle} onClick={() => setEditing("new")}>Add buyer</button>
        <button
          type="button"
          className={`${selected.size ? darkButtonClass : buttonClass} !h-8`}
          style={selected.size ? darkButtonStyle : buttonStyle}
          disabled={!selected.size}
          title={selected.size ? undefined : "Tick buyers first"}
          onClick={() => setTeaser(true)}
        >
          Send teaser to selected
        </button>
      </header>

      <div className="overflow-x-auto">
        <div className="min-w-[990px]">
          <div
            data-table-part="grid-header"
            className={`grid ${COLUMNS} gap-3.5 border-b px-3 py-2 font-medium`}
            style={{ color: "var(--bt-muted)", background: "var(--bt-table-head)", borderColor: "var(--bt-column)" }}
          >
            <span /><span>Buyer</span><span>Wants</span><span>Status</span><span>Last touch</span><span>Chase on</span><span>Bid</span><span>Activity</span>
          </div>
          {buyers.map((buyer) => (
            <div key={buyer.id} data-table-part="grid-row" className={`group grid ${COLUMNS} items-center gap-3.5 border-b px-3 py-2 text-xs hover:bg-[var(--bt-row-hover)]`} style={{ borderColor: "var(--bt-divider)" }}>
              <TableCellContent>
              <input
                type="checkbox"
                aria-label={`Select ${buyer.name}`}
                checked={selected.has(buyer.id)}
                onChange={() => toggle(buyer.id)}
                className="h-[18px] w-[18px] accent-[var(--bt-text)]"
              />
              </TableCellContent>
              <TableCellContent>
              <button type="button" className="min-w-0 text-left" onClick={() => setEditing(buyer)}>
                <div className="truncate font-semibold hover:underline">{buyer.name}</div>
              </button>
              </TableCellContent>
              <TableCellContent><span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{buyer.wants}</span></TableCellContent>
              <TableCellContent>
              <div className="flex flex-col items-start gap-1">
                <select
                  aria-label={`Status for ${buyer.name}`}
                  value={buyer.status}
                  onChange={(event) => changeStatus(buyer, event.target.value as BuyerStatus)}
                  className="max-w-full cursor-pointer appearance-none rounded-lg border px-2 py-0.5 text-xs font-medium"
                  style={statusStyle(buyer.status)}
                >
                  {BUYER_STATUSES.map((status) => <option key={status}>{status}</option>)}
                </select>
              </div>
              </TableCellContent>
              <TableCellContent>
              <span className="text-xs" style={{ color: "var(--bt-text-2)" }}>
                {buyer.last_touch_on
                  ? [buyer.last_touch_via, shortDate(buyer.last_touch_on)].filter(Boolean).join(" · ")
                  : ""}
              </span>
              </TableCellContent>
              <TableCellContent>
              <span
                className="text-xs"
                style={{ color: buyer.chase_on && buyer.chase_on <= today ? "var(--bt-red)" : "var(--bt-muted)" }}
              >
                {buyer.chase_on ? shortDate(buyer.chase_on) : ""}
              </span>
              </TableCellContent>
              <TableCellContent>
              {buyer.latest_bid ? (
                <button
                  type="button"
                  onClick={() => setBidFor(buyer)}
                  title="Add a newer bid"
                  className="bt-mono h-7 justify-self-start truncate text-left text-xs font-medium hover:underline"
                >
                  {bidLabel(buyer.latest_bid)}
                </button>
              ) : buyer.auction?.last_offer ? (
                <button type="button" aria-label={`Add bid for ${buyer.name}`} title="Record a newer bid"
                  onClick={() => setBidFor(buyer)} className="bt-mono h-7 text-left hover:underline">
                  {auctionOfferLabel(buyer.auction.last_offer)}
                </button>
              ) : (
                <button
                  type="button"
                  aria-label="Add bid"
                  onClick={() => setBidFor(buyer)}
                  className="h-7 justify-self-start px-2 text-xs font-medium opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  style={{ color: "var(--bt-muted)" }}
                >
                  + Bid
                </button>
              )}
              </TableCellContent>
              <span className="truncate" title={buyer.auction?.email}>
                {buyer.auction ? auctionStatus(buyer.auction) : buyer.link_clicked_at || buyer.email_tracking?.clicked_at ? "Clicked" : buyer.email_tracking?.opened_at ? "Opened" : buyer.email_tracking?.sent_at ? "Sent" : "—"}
              </span>
            </div>
          ))}
          {auction?.people.filter((person) => !buyers.some((buyer) =>
            buyer.id === person.buyer_id || buyer.auction?.email.toLowerCase() === person.email.toLowerCase()
            || buyer.person_email?.toLowerCase() === person.email.toLowerCase() || buyer.contact?.toLowerCase() === person.email.toLowerCase()
          )).map((person) => <AuctionRow key={person.email} tradeId={trade.id} person={person} columns={COLUMNS} onChanged={onProposalDecided} />)}
          {!buyers.length && !auction?.people.length && (
            <p className="px-5 py-6 text-sm" style={{ color: "var(--bt-muted)" }}>No buyers yet.</p>
          )}
        </div>
      </div>
      {proposals.map((proposal) => (
        <div key={proposal.id} className="border-b" style={{ borderColor: "var(--bt-column)" }}>
          <ProposalRow proposal={proposal} onDecided={onProposalDecided} />
        </div>
      ))}
      <div className="px-5 py-2"><ErrorText error={error} /></div>

      {editing && (
        <BuyerDialog
          trade={trade}
          buyer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(buyer) => { onBuyer(buyer); setEditing(null); }}
          onEmail={editing !== "new" && editing.person_email ? () => { setEmailing(editing); setEditing(null); } : undefined}
        />
      )}
      {emailing && (
        <EmailDialog
          trade={trade}
          to={emailing.person_email ?? ""}
          subject={BUYER_SUBJECT}
          body={`${greeting(emailing.contact ?? emailing.name)}\n\n`}
          buyerId={emailing.id}
          linkTracking={linkTracking}
          onClose={() => setEmailing(null)}
        />
      )}
      {bidFor && (
        <BidDialog trade={trade} buyer={bidFor} onClose={() => setBidFor(null)} onSaved={(buyer) => { onBuyer(buyer); setBidFor(null); }} />
      )}
      {teaser && (
        <TeaserDialog
          trade={trade}
          fields={fields}
          buyers={buyers.filter((buyer) => selected.has(buyer.id))}
          linkTracking={linkTracking}
          onClose={() => setTeaser(false)}
          onMarked={(saved) => { saved.forEach(onBuyer); setSelected(new Set()); setTeaser(false); }}
        />
      )}
    </Card>
  );
}

