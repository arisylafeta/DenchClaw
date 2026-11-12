"use client";

import { CopyIdButton } from "./copy-id-button";
import { ArrowLeft } from "lucide-react";
import type { Demand } from "@/lib/bulk-demand";
import { demandStarted, demandTitle, demandValue } from "@/lib/bulk-demand-header";
import type { DemandSupply } from "@/lib/demand-supply-types";
import css from "./demand-header.module.css";
import { Sh } from "./bt-shimmer";
import { WaitingBadge } from "./opportunities-sheet";

/** A circular score: the ring fills with the score out of 100. */
export function ScoreRing({ score }: { score: number | null }) {
  const color = score == null ? "var(--bt-border-strong)" : score >= 80 ? "var(--bt-green)" : score >= 60 ? "var(--bt-amber)" : "var(--bt-muted)";
  const radius = 29;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={css.ring} role="img" aria-label={score == null ? "Not scored" : `Score ${score} out of 100`}>
      <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
        <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--bt-segment)" strokeWidth="5" />
        {score != null && (
          <circle cx="32" cy="32" r={radius} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.min(Math.max(score, 0), 100) / 100)} />
        )}
      </svg>
      <span className={css.ringNum} style={{ color: score == null ? "var(--bt-muted)" : undefined }}>{score ?? "–"}</span>
    </div>
  );
}

/** Score, headline, buyer, status, three facts and a short brief. A fact we don't have says so quietly. */
export function DemandHeader({ demand, supply, actions, onBack, isTrade = false, loadingSupply = false, waiting = null, ownerPicker = null }: {
  ownerPicker?: React.ReactNode;
  isTrade?: boolean; waiting?: { waiting_on: "us" | "them" | null; waiting_since: string | null } | null; demand: Demand; supply: DemandSupply | null; actions: React.ReactNode; loadingSupply?: boolean; onBack?: () => void;
}) {
  const value = demandValue(demand);
  const started = demandStarted(demand);
  const sellers = [...new Set((supply?.shortlisted ?? []).map((unit) => unit.seller).filter(Boolean))] as string[];
  return (
    <header className={css.root}>
      {onBack && (
        <button type="button" onClick={onBack} className={css.back}>
          <ArrowLeft size={13} aria-hidden /> Bulk Trades
        </button>
      )}
      <div className={css.titleRow}>
        <ScoreRing score={demand.score} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1"><h2 className={css.title}>{demandTitle(demand)}</h2><CopyIdButton id={demand.id} className="mt-1" /></div>
          <div className={css.sub}>
            <span>{demand.buyer}</span>{isTrade && <span className={`${css.chip} ${css.chipGreen}`}>TRADE</span>}
            {demand.tier && <span className={css.chip}>{demand.tier}-tier</span>}
            {demand.priority && <span className={`${css.chip} ${css.chipGreen}`}>Priority</span>}
            {demand.status !== "open" && <span className={css.chip}>{demand.status}</span>}
          </div>
        </div>
        <div className={`${css.status} ${css.actions}`}>{actions}</div>
      </div>
      {(waiting?.waiting_on || ownerPicker) && (
        <div className={css.controls} data-deal-controls>{waiting?.waiting_on && <WaitingBadge row={waiting} />}{ownerPicker}</div>
      )}
      <dl className={css.facts}>
        <div className={css.fact}>
          <dt>Supplier</dt>
          <dd className={sellers.length ? undefined : css.quiet}>
            <Sh on={loadingSupply} chars={14}>{sellers.length ? sellers.slice(0, 2).join(", ") : "Not chosen yet"}</Sh>
            {sellers.length > 2 && <small>+{sellers.length - 2} more</small>}
          </dd>
        </div>
        <div className={css.fact}>
          <dt>Started</dt>
          <dd className={started ? undefined : css.quiet}>{started ?? "Not recorded"}</dd>
        </div>
        <div className={css.fact}>
          <dt>Approx. value</dt>
          <dd className={value ? undefined : css.quiet}>{value?.text ?? "Not priced"}{value?.note && <small>{value.note}</small>}</dd>
        </div>
      </dl>
    </header>
  );
}
