"use client";

import type { SheetRow, SheetTone } from "@/lib/bulk-sheet";
import { shortDate } from "@/lib/bulk-trade-details";
import { BusyRegion } from "./bt-shimmer";
import { ScoreCircle, SideChip } from "./opportunities-sheet";

/** Read-only pipeline. A card sits in the column of the furthest stage any of its offers has reached, so moving work
 * on happens in the listing (offers and stages), not by dragging. */
const COLUMNS: { name: string; progress: string[]; tone: SheetTone }[] = [
  { name: "New", progress: ["New", "Being worked", "Offered"], tone: "new" },
  { name: "To contact", progress: ["To contact"], tone: "new" },
  { name: "Sent", progress: ["Sent"], tone: "waiting" },
  { name: "Specs and NDA", progress: ["Specs and NDA"], tone: "active" },
  { name: "Bid in", progress: ["Bid in"], tone: "active" },
  { name: "Trade", progress: ["Trade"], tone: "closing" },
  { name: "On hold", progress: ["On hold"], tone: "hold" },
  { name: "Declined or lost", progress: ["Declined", "Lost"], tone: "waiting" },
];
const DOT: Record<SheetTone, string> = { new: "var(--bt-muted)", active: "var(--bt-blue)", waiting: "var(--bt-amber)", closing: "var(--bt-green)", hold: "var(--bt-purple)" };

function Card({ row, today, onOpen }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void }) {
  const overdue = !!row.next_due && row.next_due < today;
  return (
    <li>
      <button type="button" onClick={() => onOpen(row)}
        className="flex w-full flex-col gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors hover:border-[var(--bt-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
        style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <span className="flex items-start gap-2">
          <ScoreCircle score={row.score} size={24} />
          <span className="min-w-0 flex-1 text-[13px] font-medium leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{row.title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <SideChip side={row.side} />
          {row.company && <span className="truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{row.company}</span>}
        </span>
        {(row.next_action || row.latest) && (
          <span className="flex items-baseline gap-1.5 border-t pt-2 text-[12px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
            <span className="min-w-0 flex-1 truncate">{row.next_action ?? row.latest?.label}</span>
            {row.next_due
              ? <span className="shrink-0" style={{ color: overdue ? "var(--bt-red)" : "var(--bt-muted)", fontWeight: overdue ? 600 : 400 }}>{shortDate(row.next_due)}</span>
              : !row.next_action && row.latest?.at && <span className="shrink-0" style={{ color: "var(--bt-muted)" }}>{shortDate(row.latest.at)}</span>}
          </span>
        )}
      </button>
    </li>
  );
}

export function BulkBoard({ shown, loading, error, today, onOpen }: { shown: SheetRow[]; loading: boolean; error: string | null; today: string; onOpen: (row: SheetRow) => void }) {
  const known = new Set(COLUMNS.flatMap((column) => column.progress));
  return (
    <BusyRegion busy={loading} label="Loading…">
      {error && <p className="text-[13px]" role="alert" style={{ color: "var(--bt-red)" }}>{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Pipeline">
        {COLUMNS.map((column) => {
          const cards = shown.filter((row) => column.progress.includes(row.progress) || (column.name === "New" && !known.has(row.progress)));
          return (
            <section key={column.name} aria-label={column.name} className="flex w-[17.5rem] shrink-0 flex-col gap-2 rounded-xl p-2" style={{ background: "var(--bt-segment)" }}>
              <header className="flex items-center gap-2 px-1.5 pb-0.5 pt-1">
                <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: DOT[column.tone] }} />
                <h2 className="text-[13px] font-semibold">{column.name}</h2>
                <span className="text-[12px] tabular-nums" style={{ color: "var(--bt-muted)" }}>{cards.length}</span>
              </header>
              <ul className="flex flex-col gap-2">
                {cards.map((row) => <Card key={row.key} row={row} today={today} onOpen={onOpen} />)}
              </ul>
              {!cards.length && <p className="px-1.5 pb-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>Nothing here</p>}
            </section>
          );
        })}
      </div>
    </BusyRegion>
  );
}
