"use client";

import { useState } from "react";
import type { BulkTrade } from "@/lib/bulk-trades";
import tableStyles from "../ui/data-table.module.css";
import {
  BUYER_STATUSES,
  BUYER_SUBJECT,
  auctionLabel,
  bidLabel,
  greeting,
  shortDate,
  trackingLabel,
  type Buyer,
  type BuyerStatus,
  type Proposal,
  type TradeField,
} from "@/lib/bulk-trade-details";
import { BidDialog, BuyerDialog, TeaserDialog } from "./buyer-dialogs";
import { EmailDialog } from "./email-dialog";
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

const COLUMNS = "grid-cols-[24px_minmax(180px,1.3fr)_minmax(140px,1fr)_170px_120px_100px_130px]";

type Props = {
  trade: BulkTrade;
  buyers: Buyer[];
  fields: TradeField[];
  today: string;
  linkTracking: boolean;
  proposals: Proposal[];
  onProposalDecided: () => void;
  onBuyer: (buyer: Buyer) => void;
};

export function BuyersTable({ trade, buyers, fields, today, linkTracking, proposals, onProposalDecided, onBuyer }: Props) {
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
            <span /><span>Buyer</span><span>Wants</span><span>Status</span><span>Last touch</span><span>Chase on</span><span>Bid</span>
          </div>
          {buyers.map((buyer) => (
            <div key={buyer.id} data-table-part="grid-row" className={`group grid ${COLUMNS} items-center gap-3.5 border-b px-3 py-2 text-xs hover:bg-[var(--bt-row-hover)]`} style={{ borderColor: "var(--bt-divider)" }}>
              <input
                type="checkbox"
                aria-label={`Select ${buyer.name}`}
                checked={selected.has(buyer.id)}
                onChange={() => toggle(buyer.id)}
                className="h-[18px] w-[18px] accent-[var(--bt-text)]"
              />
              <button type="button" className="min-w-0 text-left" onClick={() => setEditing(buyer)}>
                <div className="truncate font-semibold hover:underline">{buyer.name}</div>
                {buyer.contact && <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{buyer.contact}</div>}
                <TrackingLine buyer={buyer} />
                <AuctionLine buyer={buyer} />
              </button>
              <span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{buyer.wants}</span>
              <div className="flex flex-col items-start gap-1">
                <select
                  aria-label={`Status for ${buyer.name}`}
                  value={buyer.status}
                  onChange={(event) => changeStatus(buyer, event.target.value as BuyerStatus)}
                  className="max-w-full cursor-pointer appearance-none rounded-none border px-2 py-0.5 text-xs font-medium"
                  style={statusStyle(buyer.status)}
                >
                  {BUYER_STATUSES.map((status) => <option key={status}>{status}</option>)}
                </select>
                {buyer.status === "To contact" && buyer.email_tracking?.sent_at && (
                  <button type="button" onClick={() => changeStatus(buyer, "Teaser sent")} className="text-xs underline" style={{ color: "var(--bt-link)" }}>
                    Mark as Teaser sent?
                  </button>
                )}
              </div>
              <span className="text-xs" style={{ color: "var(--bt-text-2)" }}>
                {buyer.last_touch_on
                  ? [buyer.last_touch_via, shortDate(buyer.last_touch_on)].filter(Boolean).join(" · ")
                  : ""}
              </span>
              <span
                className="text-xs"
                style={{ color: buyer.chase_on && buyer.chase_on <= today ? "var(--bt-red)" : "var(--bt-muted)" }}
              >
                {buyer.chase_on ? shortDate(buyer.chase_on) : ""}
              </span>
              {buyer.latest_bid ? (
                <button
                  type="button"
                  onClick={() => setBidFor(buyer)}
                  title="Add a newer bid"
                  className="bt-mono h-7 justify-self-start truncate text-left text-xs font-medium hover:underline"
                >
                  {bidLabel(buyer.latest_bid)}
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
            </div>
          ))}
          {!buyers.length && (
            <p className="px-5 py-6 text-sm" style={{ color: "var(--bt-muted)" }}>No buyers yet. Add the first one to start tracking outreach.</p>
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

const TRACKING_TONE = {
  red: "var(--bt-red)",
  green: "var(--bt-green)",
  grey: "var(--bt-muted)",
} as const;

function AuctionLine({ buyer }: { buyer: Buyer }) {
  const label = buyer.auction && auctionLabel(buyer.auction);
  if (!label) return null;
  return (
    <div className="mt-0.5 truncate text-xs font-medium" style={{ color: TRACKING_TONE[label.tone] }} title={buyer.auction!.email}>
      {label.label}
    </div>
  );
}

function TrackingLine({ buyer }: { buyer: Buyer }) {
  const tracking = buyer.email_tracking;
  const label = tracking && trackingLabel(tracking);
  const campaignAt = tracking && (tracking.bounced_at ?? tracking.clicked_at ?? tracking.opened_at ?? tracking.delivered_at ?? tracking.sent_at);
  if (buyer.link_clicked_at && (!campaignAt || Date.parse(buyer.link_clicked_at) > Date.parse(campaignAt))) {
    return (
      <div className="mt-0.5 truncate text-xs font-medium" style={{ color: TRACKING_TONE.green }}>
        Clicked email link {shortDate(new Date(buyer.link_clicked_at).toISOString().slice(0, 10))}
      </div>
    );
  }
  if (!label) return null;
  return (
    <div className="mt-0.5 truncate text-xs font-medium" style={{ color: TRACKING_TONE[label.tone] }} title={tracking!.campaign ?? undefined}>
      Teaser email: {label.label}
    </div>
  );
}
