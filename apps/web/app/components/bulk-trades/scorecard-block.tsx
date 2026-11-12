"use client";

import { useEffect, useState } from "react";
import { arrow, type Scorecard } from "@/lib/bulk-scorecard";
import { ErrorText, request } from "./trade-ui";

/** The scorecard on Today (slice 6): the eleven measures for the last full week against target, the quarter beside each,
 * and "how counted" one click away. Whole desk, whatever owner is picked. Read only. */
export function ScorecardBlock() {
  const [card, setCard] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    request<Partial<Scorecard>>("/api/bulk-scorecard")
      .then((r) => { if (live && Array.isArray(r.week) && r.periods) setCard(r as Scorecard); })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : "Could not load the scorecard."); });
    return () => { live = false; };
  }, []);
  if (!card && !error) return null;
  const before = new Map(card?.previous.map((m) => [m.key, m]) ?? []);
  const quarter = new Map(card?.quarter.map((m) => [m.key, m]) ?? []);
  return (
    <section aria-label="Scorecard" className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h2 className="text-[15px] font-semibold">Scorecard{card && <span className="font-normal" style={{ color: "var(--bt-muted)" }}> · {card.periods.week.label}</span>}</h2>
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Whole desk. Value against target; arrows compare with the week before. Click a line for how it is counted.</p>
      </header>
      <ErrorText error={error} />
      <ul className="divide-y divide-[var(--bt-divider)]">
        {card?.week.map((m) => {
          const a = arrow(m, before.get(m.key));
          const q = quarter.get(m.key);
          const shown = open === m.key;
          return (
            <li key={m.key} data-measure={m.key} className="text-[13px]">
              <button type="button" aria-expanded={shown} onClick={() => setOpen(shown ? null : m.key)}
                className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-[var(--bt-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]">
                <span className="w-5 shrink-0 tabular-nums" style={{ color: "var(--bt-muted)" }}>{m.n}</span>
                <span className="min-w-0 flex-1">{m.name}</span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="font-semibold" style={{ color: m.met === true ? "var(--bt-green)" : m.met === false ? "var(--bt-red)" : "var(--bt-muted)" }}>{m.shown}</span>
                  {a && <span className="ml-1" style={{ color: "var(--bt-muted)" }}>{a}</span>}
                  <span className="block text-[12px]" style={{ color: "var(--bt-muted)" }}>target {m.target}</span>
                </span>
              </button>
              {shown && (
                <div className="px-4 pb-3 pl-12 text-[12px]" style={{ color: "var(--bt-text-2)" }}>
                  <p>{m.how}</p>
                  <p className="mt-1" style={{ color: "var(--bt-muted)" }}>Quarter: {q?.shown ?? "no data yet"}. Baseline 12 Nov 2026: {m.baseline}.</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
