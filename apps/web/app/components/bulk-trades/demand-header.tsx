"use client";

import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { Demand } from "@/lib/bulk-demand";
import { demandDescription, demandStarted, demandTitle, demandValue } from "@/lib/bulk-demand-header";
import type { DemandSupply } from "@/lib/demand-supply-types";
import css from "./demand-header.module.css";

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
export function DemandHeader({ demand, supply, actions, onBack }: {
  demand: Demand; supply: DemandSupply | null; actions: React.ReactNode; onBack?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const description = demandDescription(demand);
  const words = description.split(/\s+/);
  const long = words.length > 42;
  const value = demandValue(demand);
  const started = demandStarted(demand);
  const sellers = [...new Set((supply?.shortlisted ?? []).map((unit) => unit.seller).filter(Boolean))] as string[];
  return (
    <header className={css.root}>
      {onBack && (
        <button type="button" onClick={onBack} className={css.back}>
          <ArrowLeft size={13} aria-hidden /> Trades Preview
        </button>
      )}
      <div className={css.titleRow}>
        <ScoreRing score={demand.score} />
        <div className="min-w-0 flex-1">
          <h2 className={css.title}>{demandTitle(demand)}</h2>
          <div className={css.sub}>
            <span>{demand.buyer}</span>
            {demand.tier && <span className={css.chip}>{demand.tier}-tier</span>}
            {demand.priority && <span className={`${css.chip} ${css.chipGreen}`}>Priority</span>}
            {demand.status !== "open" && <span className={css.chip}>{demand.status}</span>}
          </div>
        </div>
        <div className={`${css.status} ${css.actions}`}>{actions}</div>
      </div>
      <dl className={css.facts}>
        <div className={css.fact}>
          <dt>Supplier</dt>
          <dd className={sellers.length ? undefined : css.quiet}>
            {sellers.length ? sellers.slice(0, 2).join(", ") : supply ? "Not chosen yet" : "…"}
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
      {description && (
        <div className={css.brief} data-open={open}>
          <p>{long && !open ? `${words.slice(0, 42).join(" ")}…` : description}</p>
          {long && <button type="button" aria-expanded={open} className={css.more} onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
        </div>
      )}
    </header>
  );
}
