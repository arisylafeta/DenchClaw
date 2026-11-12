"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { type BuyerCardData, monthYear, rangeText } from "@/lib/buyer-card";
import { Sh } from "./bt-shimmer";

const muted = { color: "var(--bt-muted)" };
const divider = { borderColor: "var(--bt-divider)" };

function Stat({ label, value, sub, loading }: { label: string; value: string | null; sub?: string | null; loading?: boolean }) {
  return (
    <div className="min-w-0 pr-3 [&+&]:border-l [&+&]:pl-3.5" style={divider}>
      <div className="text-[11px]" style={muted}>{label}</div>
      {loading ? <div className="mt-1 h-[26px]"><Sh on chars={5} /></div>
        : value ? <div className="mt-0.5 whitespace-nowrap text-[18px] font-semibold leading-[1.15] tracking-[-0.02em] tabular-nums sm:text-[22px]">{value}</div>
          : <div className="mt-0.5 py-1 text-[15px] font-medium" style={muted}>None yet</div>}
      {sub && !loading && <div className="mt-px text-[11px]" style={muted}>{sub}</div>}
    </div>
  );
}

/** The €/kWh rail: their target as a band, their own deals as dated dots, other buyers' deals as a band on a second lane. */
function Track({ card }: { card: BuyerCardData }) {
  const values = [card.target?.high, card.paid?.points.length ? card.paid.high : null, card.others?.high].filter((v): v is number => v != null && Number.isFinite(v));
  if (!values.length) return null;
  const max = Math.max(40, Math.ceil(Math.max(...values) / 10) * 10);
  const at = (value: number) => `${(value / max) * 100}%`;
  const width = (low: number, high: number) => `max(6px, ${((high - low) / max) * 100}%)`;
  const ticks = Array.from({ length: max / 10 + 1 }, (_, i) => i * 10);
  const label = [
    card.target && `their target ${rangeText(card.target)}`,
    card.paid && `they paid ${card.paid.points.map((p) => p.eur_per_kwh).join(", ")}`,
    card.others && `others paid ${rangeText(card.others)} over ${card.others.count}`,
  ].filter(Boolean).join("; ");
  const rail = "absolute inset-x-0 top-2 h-1.5 rounded-full";
  return (
    <div className="mx-1 mt-1.5">
      <div className={`relative ${card.target || card.paid?.points.length ? "h-[88px]" : "h-[44px]"}`} role="img" aria-label={`€/kWh: ${label}`}>
        {(card.target || card.paid?.points.length) && <div className="absolute inset-x-0 top-4 h-7">
          <div className={rail} style={{ background: "var(--bt-divider)" }} />
          {card.target && (
            <div className="absolute top-[7px] h-2 rounded-full" style={{ left: at(card.target.low), width: width(card.target.low, card.target.high), background: "var(--bt-accent)", boxShadow: "inset 0 0 0 1px rgba(104,112,0,.45)" }}>
              <span className="absolute left-0 top-[11px] whitespace-nowrap text-[10.5px] font-semibold" style={{ color: "#687000" }}>target</span>
            </div>
          )}
          {card.paid?.points.map((point, i) => (
            <div key={`${point.seen}-${i}`} className="absolute top-[3px] -translate-x-1/2" style={{ left: at(point.eur_per_kwh) }}>
              {point.seen && <span className="absolute bottom-full left-1/2 mb-px -translate-x-1/2 whitespace-nowrap text-[10.5px]" style={muted}>{monthYear(point.seen)}</span>}
              <span className="block h-2.5 w-2.5 rounded-full border-2 border-white" style={{ background: "var(--bt-green)", boxShadow: "0 0 0 1px var(--bt-green)" }} />
            </div>
          ))}
        </div>}
        {card.others && (
          <div className={`absolute inset-x-0 h-7 ${card.target || card.paid?.points.length ? "top-[50px]" : "top-0"}`}>
            <div className={rail} style={{ background: "var(--bt-divider)" }} />
            <div className="absolute top-[7px] h-2 rounded-full bg-white" style={{ left: at(card.others.low), width: width(card.others.low, card.others.high), boxShadow: "inset 0 0 0 1.5px var(--bt-text-2)" }}>
              <span className="absolute left-0 top-[11px] whitespace-nowrap text-[10.5px]" style={muted}>others · {card.others.count}</span>
            </div>
          </div>
        )}
      </div>
      <div className="relative h-3.5 text-[10.5px] tabular-nums" aria-hidden="true" style={muted}>
        {ticks.map((tick) => <span key={tick} className="absolute -translate-x-1/2" style={{ left: at(tick) }}>{tick}</span>)}
      </div>
    </div>
  );
}

const CHIPS_SHOWN = 3;

/** Status line of the Buyer card: tier and stage, last heard, how fast they decide. */
export function BuyerStatus({ stage, lastHeard, card }: { stage: string | null; lastHeard: string | null; card: BuyerCardData | null }) {
  const items = [lastHeard ? `Last heard ${lastHeard}` : null, card?.decides ?? null].filter(Boolean);
  if (!stage && !items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-4 pb-3.5 text-[12px]" style={{ color: "var(--bt-text-2)" }}>
      {stage && <b className="font-semibold" style={{ color: "var(--bt-text)" }}>{stage}</b>}
      {items.map((item, i) => (
        <span key={item}>{i === 0 && lastHeard && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-[1px]" style={{ background: "var(--bt-green)" }} />}{item}</span>
      ))}
    </div>
  );
}

/** The quick-scan body of the Buyer card: price benchmark, products, facts and a footer. */
export function BuyerCardBody({ card, loading, related, profileHref }: {
  card: BuyerCardData | null; loading: boolean;
  related?: { id: string; label: string; onOpen?: () => void }[];
  profileHref: string | null;
}) {
  const [allChips, setAllChips] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const sec = "border-t px-4 py-3.5";
  if (loading || !card) {
    return (
      <>
        <div className={sec} style={divider}>
          <div className="mb-2.5 text-[13px] font-semibold"><Sh on chars={14} /></div>
          <div className="grid grid-cols-3"><Stat label="Their target" value={null} loading /><Stat label="They paid us" value={null} loading /><Stat label="Others paid us" value={null} loading /></div>
          <div className="h-[104px]" />
        </div>
        <div className={sec} style={divider}><div className="mb-2.5 text-[12px] font-semibold">Buys</div><div className="flex gap-1.5">{[110, 90, 120].map((w) => <span key={w} className="h-[26px] rounded-md" style={{ width: w, background: "var(--bt-divider)" }} />)}</div></div>
      </>
    );
  }
  const researched = card.basis === "researched";
  const showPrice = !researched && (card.basis === "dossier" || card.target || card.paid || card.others);
  const chips = allChips ? card.chips : card.chips.slice(0, CHIPS_SHOWN);
  const hidden = card.chips.length - chips.length;
  const others = related ?? [];
  return (
    <>
      {showPrice && (
        <div className={sec} style={divider}>
          <div className="mb-2.5 flex items-baseline justify-between gap-2">
            <h4 className="text-[13px] font-semibold">{card.priceTopic ?? "Price"} <span className="ml-1 font-medium" style={muted}>€/kWh</span></h4>
          </div>
          <div className="grid grid-cols-3">
            <Stat label="Their target" value={card.target ? rangeText(card.target) : null} sub={monthYear(card.target?.seen ?? null)} />
            <Stat label="They paid us" value={card.paid?.points.length ? rangeText(card.paid) : card.paid ? "Per unit" : null} sub={card.paid ? `${card.paid.count} ${card.paid.count === 1 ? "deal" : "deals"}${card.paid.last ? `, last ${monthYear(card.paid.last)}` : ""}` : null} />
            <Stat label="Others paid us" value={card.others ? rangeText(card.others) : null} sub={card.others ? `${card.others.count} ${card.others.count === 1 ? "deal" : "deals"}, 18 months` : null} />
          </div>
          <Track card={card} />
        </div>
      )}
      {card.chips.length > 0 && (
        <div className={sec} style={divider}>
          <div className="mb-2.5 flex items-baseline justify-between gap-2">
            <h4 className="text-[12px] font-semibold">{researched ? "Likely buys" : "Buys"}</h4>
            <span className="text-[12px]" style={muted}>{researched ? "from web research, not confirmed" : card.basis === "stated" ? "stated by them" : "newest first"}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chips.map((chip) => (
              <span key={chip.label} className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium"
                style={researched ? { border: "1px solid var(--bt-border)", color: "var(--bt-text-2)" } : chip.bought ? { background: "var(--bt-green-bg)", color: "#0b5e34" } : { background: "var(--bt-segment)" }}
                title={chip.bought ? "Bought from us" : undefined}>
                {chip.bought && <Check size={12} strokeWidth={2.4} aria-label="Bought from us" />}
                <span className="truncate">{chip.label}</span>
                {chip.seen && !researched && <small className="text-[11px] font-normal" style={{ color: chip.bought ? "#2f7a52" : "var(--bt-muted)" }}>{monthYear(chip.seen)}</small>}
              </span>
            ))}
            {hidden > 0 && <button type="button" aria-expanded={false} onClick={() => setAllChips(true)} className="inline-flex h-[26px] items-center rounded-md border border-dashed px-2.5 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ borderColor: "var(--bt-border)", color: "var(--bt-muted)" }}>+{hidden} more</button>}
            {allChips && card.chips.length > CHIPS_SHOWN && <button type="button" aria-expanded onClick={() => setAllChips(false)} className="inline-flex h-[26px] items-center px-1.5 text-[12px] underline" style={muted}>Show less</button>}
          </div>
        </div>
      )}
      {card.facts.length > 0 && (
        <div className={sec} style={divider}>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3.5 sm:grid-cols-4">
            {card.facts.map((fact) => (
              <div key={fact.label} className="min-w-0">
                <dt className="text-[11px]" style={muted}>{fact.label}</dt>
                <dd className="mt-0.5 truncate text-[13px] font-semibold tabular-nums" title={fact.value}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {(card.pastIssue || others.length > 0 || card.verified || profileHref) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5 text-[12px]" style={divider}>
          {card.pastIssue && (
            <button type="button" aria-expanded={issueOpen} onClick={() => setIssueOpen((open) => !open)} className="inline-flex h-6 items-center gap-1.5 rounded-md px-2 font-medium focus-visible:outline-2 focus-visible:outline-[var(--bt-text)]" style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)" }} title={card.pastIssue}>
              <AlertTriangle size={12} aria-hidden="true" />Past issue
            </button>
          )}
          {others.length > 0 && (
            <span style={{ color: "var(--bt-text-2)" }}>Also asking for{" "}
              {others.map((item, i) => (
                <span key={item.id}>{i > 0 && ", "}{item.onOpen ? <button type="button" className="underline" style={{ color: "var(--bt-text)" }} onClick={item.onOpen}>{item.label}</button> : item.label}</span>
              ))}
            </span>
          )}
          <span className="flex-1" />
          {card.verified && <span style={muted}>Verified {card.verified.slice(8, 10).replace(/^0/, "")} {monthYear(card.verified)}</span>}
          {profileHref && <a href={profileHref} className="inline-flex min-h-6 items-center font-medium underline decoration-[var(--bt-border)] underline-offset-2">{card.basis === "dossier" ? "Dossier" : "Buyer profile"}</a>}
          {issueOpen && card.pastIssue && <p className="w-full whitespace-pre-line text-[12px]" style={{ color: "var(--bt-amber)" }}>{card.pastIssue}</p>}
        </div>
      )}
    </>
  );
}
