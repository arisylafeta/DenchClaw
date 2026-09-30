"use client";

import { useState } from "react";
import {
  GROUPS,
  GROUP_TONE,
  dismantlerGroup,
  dueLabel,
  nextStage,
  type Dismantler,
  type Stage,
} from "@/lib/dismantlers";
import { dayMonth } from "@/lib/bulk-trades";
import { DueChip } from "../bulk-trades/trade-chips";
import { GoalTag, StageDot, metaLine } from "./dismantler-ui";

const FOUND_SHOWN = 30;
const ACTIVE: Stage[] = ["Contacted", "Onboarding", "Live", "Syncing"];

type Props = {
  dismantlers: Dismantler[];
  today: string;
  onOpen: (d: Dismantler) => void;
  onMove: (d: Dismantler, stage: Stage) => void;
  onShowList: () => void;
};

const EMPTY: Partial<Record<Stage, string>> = {
  Syncing: "None yet. A dismantler moves here after two syncs at least 7 days apart, with a sold or changed item updated.",
};

function useDrop(stage: Stage, dismantlers: Dismantler[], onMove: Props["onMove"]) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (event: React.DragEvent) => { event.preventDefault(); setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        setOver(false);
        const d = dismantlers.find((candidate) => candidate.id === event.dataTransfer.getData("text/plain"));
        if (d && d.stage !== stage) onMove(d, stage);
      },
    },
  };
}

const drag = (d: Dismantler) => ({
  draggable: true,
  onDragStart: (event: React.DragEvent) => event.dataTransfer.setData("text/plain", d.id),
});

function ColumnHeader({ stage, count }: { stage: Stage; count: number }) {
  return (
    <header className="flex items-center gap-2 border-b px-3.5 py-3" style={{ borderColor: "var(--bt-divider)" }}>
      <StageDot stage={stage} />
      <h2 className="flex-1 text-sm font-semibold">{stage}</h2>
      <span className="bt-mono text-xs" style={{ color: "var(--bt-muted)" }}>{count}</span>
    </header>
  );
}

const columnStyle = (over: boolean) => ({
  background: over ? "var(--bt-column-over)" : "var(--bt-surface)",
  borderColor: "var(--bt-border)",
});

/** Found: one-line rows that unfold in place, most eBay listings first. */
function FoundColumn({ dismantlers, onOpen, onMove, onShowList }: Omit<Props, "today">) {
  const { over, handlers } = useDrop("Found", dismantlers, onMove);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const found = dismantlers
    .filter((d) => d.stage === "Found")
    .sort((a, b) => (b.ebay_listings ?? -1) - (a.ebay_listings ?? -1) || a.name.localeCompare(b.name));
  const toggle = (id: string) => setUnfolded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <section aria-label="Found" {...handlers} className="flex w-[250px] shrink-0 flex-col border" style={columnStyle(over)}>
      <ColumnHeader stage="Found" count={found.length} />
      <div className="flex flex-col gap-1 p-2">
        {found.slice(0, FOUND_SHOWN).map((d) => {
          const isOpen = unfolded.has(d.id);
          return (
            <div key={d.id} {...drag(d)} className="cursor-grab border active:cursor-grabbing" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
              <button type="button" aria-expanded={isOpen} onClick={() => toggle(d.id)}
                className="flex w-full items-center gap-1.5 px-2 py-[7px] text-left">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  aria-hidden="true" className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} style={{ color: "var(--bt-muted)" }}>
                  <path d="m9 18 6-6-6-6" />
                </svg>
                <span className="flex-1 truncate text-[13px] font-medium">{d.name}</span>
                {d.country && <span className="bt-mono shrink-0 text-[11px]" style={{ color: "var(--bt-muted)" }}>{d.country}</span>}
              </button>
              {isOpen && (
                <div className="flex flex-col gap-1.5 pb-2.5 pl-[26px] pr-2.5 text-xs" style={{ color: "var(--bt-text-2)" }}>
                  {metaLine(d) && <span>{metaLine(d)}</span>}
                  {d.ebay_listings != null && <span>{d.ebay_listings} battery listings on eBay</span>}
                  {d.next_step && <span>{d.next_step}</span>}
                  <div className="mt-0.5 flex gap-1.5">
                    <button type="button" onClick={() => onMove(d, "Contacted")} className="h-7 px-2.5 text-xs font-medium"
                      style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>
                      Contacted →
                    </button>
                    <button type="button" onClick={() => onOpen(d)} className="h-7 border px-2.5 text-xs font-medium"
                      style={{ borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
                      Open
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {found.length > FOUND_SHOWN && (
          <button type="button" onClick={onShowList} className="px-1.5 pb-1 pt-2 text-left text-xs hover:underline" style={{ color: "var(--bt-muted)" }}>
            {found.length - FOUND_SHOWN} more · pick a batch in the list
          </button>
        )}
        {!found.length && <Empty text="Nobody waiting to be contacted." />}
      </div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="border border-dashed px-2.5 py-4 text-center text-xs leading-[1.45]" style={{ borderColor: "var(--bt-dashed)", color: "var(--bt-muted)" }}>
      {text}
    </div>
  );
}

function Column({ stage, dismantlers, today, onOpen, onMove }: Omit<Props, "onShowList"> & { stage: Stage }) {
  const { over, handlers } = useDrop(stage, dismantlers, onMove);
  const next = nextStage(stage);
  const cards = dismantlers
    .filter((d) => d.stage === stage)
    .sort((a, b) =>
      GROUPS.indexOf(dismantlerGroup(a, today)) - GROUPS.indexOf(dismantlerGroup(b, today))
      || String(a.next_step_due ?? "9999").localeCompare(String(b.next_step_due ?? "9999")));

  return (
    <section aria-label={stage} {...handlers} className="flex w-[250px] shrink-0 flex-col border" style={columnStyle(over)}>
      <ColumnHeader stage={stage} count={cards.length} />
      <div className="flex min-h-[120px] flex-col gap-2 p-2">
        {cards.map((d) => (
          <div key={d.id} {...drag(d)} className="flex cursor-grab flex-col gap-2 border p-3 hover:border-[var(--bt-border-strong)] active:cursor-grabbing"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            <div>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => onOpen(d)} className="flex-1 truncate text-left text-sm font-semibold hover:underline">{d.name}</button>
                {d.goal && <GoalTag />}
              </div>
              <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{[d.country, d.route].filter(Boolean).join(" · ")}</div>
            </div>
            <div className="border-t pt-2 text-[13px] leading-[1.35]" style={{ borderColor: "var(--bt-divider)", color: d.next_step ? undefined : "var(--bt-muted)" }}>
              {d.next_step ?? "Set a next step"}
            </div>
            <div className="flex items-center gap-1.5">
              <DueChip label={dueLabel(d, today)} tone={GROUP_TONE[dismantlerGroup(d, today)]} />
              <span className="flex-1" />
              {next && (
                <button type="button" onClick={() => onMove(d, next)} aria-label={`Move ${d.name} to ${next}`} title={`Move to ${next}`}
                  className="h-[26px] border px-2 text-xs font-medium hover:bg-[var(--bt-row-hover)]"
                  style={{ borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
                  {next} →
                </button>
              )}
            </div>
          </div>
        ))}
        {!cards.length && <Empty text={EMPTY[stage] ?? "Nobody here yet."} />}
      </div>
    </section>
  );
}

/** Parked: a slim bar that opens into a column. Still a drop target when folded. */
function ParkedColumn({ dismantlers, today, onOpen, onMove }: Omit<Props, "onShowList">) {
  const [open, setOpen] = useState(false);
  const { over, handlers } = useDrop("Parked", dismantlers, onMove);
  const parked = dismantlers.filter((d) => d.stage === "Parked");

  if (!open) {
    return (
      <button type="button" {...handlers} onClick={() => setOpen(true)}
        aria-label={`Open Parked, ${parked.length} ${parked.length === 1 ? "dismantler" : "dismantlers"}`}
        className="flex max-h-[360px] w-11 shrink-0 flex-col items-center gap-2.5 border py-3"
        style={{ background: over ? "var(--bt-column-over)" : "var(--bt-bg)", borderColor: "var(--bt-border)" }}>
        <StageDot stage="Parked" />
        <span className="bt-mono text-xs" style={{ color: "var(--bt-muted)" }}>{parked.length}</span>
        <span className="text-sm font-semibold [writing-mode:vertical-rl]">{over ? "Drop to park" : "Parked"}</span>
      </button>
    );
  }
  return (
    <section aria-label="Parked" {...handlers} className="flex w-[250px] shrink-0 flex-col border" style={columnStyle(over)}>
      <header className="flex items-center gap-2 border-b px-3.5 py-3" style={{ borderColor: "var(--bt-divider)" }}>
        <StageDot stage="Parked" />
        <h2 className="flex-1 text-sm font-semibold">Parked</h2>
        <span className="bt-mono text-xs" style={{ color: "var(--bt-muted)" }}>{parked.length}</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Fold Parked" className="h-6 w-6 text-sm" style={{ color: "var(--bt-muted)" }}>‹</button>
      </header>
      <div className="flex flex-col gap-2 p-2">
        {parked.map((d) => (
          <div key={d.id} {...drag(d)} className="flex cursor-grab flex-col gap-1 border p-3" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            <button type="button" onClick={() => onOpen(d)} className="truncate text-left text-sm font-semibold hover:underline">{d.name}</button>
            {d.park_reason && <span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{d.park_reason}</span>}
            {d.revisit_on && (
              <span className="text-xs" style={{ color: d.revisit_on <= today ? "var(--bt-amber)" : "var(--bt-muted)" }}>
                Revisit {d.revisit_on <= today ? "now" : dayMonth(d.revisit_on)}
              </span>
            )}
          </div>
        ))}
        {!parked.length && <Empty text="Drop a card here to park it." />}
      </div>
    </section>
  );
}

export function DismantlersBoard(props: Props) {
  return (
    <div className="flex items-start gap-4 overflow-x-auto pb-4">
      <FoundColumn {...props} />
      {ACTIVE.map((stage) => <Column key={stage} stage={stage} {...props} />)}
      <ParkedColumn {...props} />
    </div>
  );
}
