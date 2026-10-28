"use client";

import { FEE_RATE, formatEurCompact, type SheetRow, type SheetTone } from "@/lib/bulk-sheet";
import { dealTotals } from "@/lib/bulk-desk";
import type { ListingStage } from "@/lib/bulk-listing";
import { BusyRegion } from "./bt-shimmer";
import { ScoreCircle, SideChip, WaitingBadge } from "./opportunities-sheet";
import { DriverAvatar, DueText, Gap } from "./desk-bits";

/** Read-only pipeline of the deal stages (bulk_listing_stage): only listings with an offer out are here. Work moves
 * on by what happens to its offers (Offers tab). Nothing is dragged. */
const COLUMNS: { name: ListingStage; tone: SheetTone; hint: string }[] = [
  { name: "Offered", tone: "waiting", hint: "Put to a counterparty" },
  { name: "Negotiating", tone: "waiting", hint: "Terms under discussion" },
  { name: "Agreed", tone: "closing", hint: "Contract out, signed or invoiced" },
  { name: "Paid", tone: "closing", hint: "Payment received" },
  { name: "Delivered", tone: "closing", hint: "Delivered" },
];
const DOT: Record<SheetTone, string> = { new: "var(--bt-muted)", active: "var(--bt-blue)", waiting: "var(--bt-amber)", closing: "var(--bt-green)", hold: "var(--bt-purple)", warning: "var(--bt-red)" };

/** One number on a card: ticket, fee or chance. A missing one is an amber prompt to fill it in. */
function Stat({ label, value, gap, title, data }: { label: string; value: string | null; gap: string; title: string; data?: string }) {
  return (
    <span className="flex min-w-0 flex-col" title={title} {...(data ? { [data]: "" } : {})}>
      <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>{label}</span>
      <span className="truncate text-[12px] font-semibold tabular-nums">{value ?? <Gap>{gap}</Gap>}</span>
    </span>
  );
}

function Card({ row, today, onOpen }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void }) {
  return (
    <li>
      <button type="button" onClick={() => onOpen(row)}
        className="flex w-full flex-col gap-2 rounded-[10px] border p-3 text-left transition-colors hover:border-[var(--bt-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
        style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <span className="flex items-start gap-2">
          <ScoreCircle score={row.score} size={24} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-semibold leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">{row.title}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <SideChip side={row.side} />
              {row.company && <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{row.company}</span>}
            </span>
          </span>
          <span data-card-owner><DriverAvatar owner={row.owner} /></span>
        </span>
        <span className="grid grid-cols-3 gap-2">
          <Stat label="Ticket" data="data-card-value" gap="Add size" value={row.value_eur != null ? formatEurCompact(row.value_eur) : null}
            title={row.value_eur != null ? `Approximate ${row.side === "buyer" ? "deal" : "stock"} value, EUR ${row.value_eur.toLocaleString("en-GB")}` : "No size recorded"} />
          <Stat label="Fee" data="data-card-fee" gap="Set fee" value={row.fee_eur != null ? formatEurCompact(row.fee_eur) : null}
            title={row.fee_eur != null ? `${row.fee_is_override ? "Fee set by hand" : `${FEE_RATE * 100}% of value`}, EUR ${row.fee_eur.toLocaleString("en-GB")}` : "No fee: set one or record a value"} />
          <Stat label="Chance" data="data-card-chance" gap="Set %" value={row.likelihood != null ? `${row.likelihood}%` : null}
            title={row.likelihood != null ? "Chance this deal completes" : "Chance not set"} />
        </span>
        <span className="flex flex-col gap-1 border-t pt-2 text-[12px] leading-snug" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
          <span className="[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden" style={row.next_action ? undefined : { color: "var(--bt-amber)", fontWeight: 500 }}>{row.next_action ?? "No next action"}</span>
          {(row.next_action && row.next_due) || row.waiting_on ? (
            <span className="flex items-center justify-between gap-2">
              {row.next_action ? <DueText due={row.next_due} today={today} /> : <span />}
              <WaitingBadge row={row} compact />
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

export function BulkBoard({ shown, loading, error, today, onOpen }: { shown: SheetRow[]; loading: boolean; error: string | null; today: string; onOpen: (row: SheetRow) => void }) {
  return (
    <BusyRegion busy={loading} label="Loading…">
      {error && <p className="text-[13px]" role="alert" style={{ color: "var(--bt-red)" }}>{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Pipeline">
        {COLUMNS.map((column) => {
          const cards = shown.filter((row) => row.progress === column.name);
          const totals = dealTotals(cards);
          return (
            <section key={column.name} aria-label={column.name} title={column.hint} className="flex w-[17.5rem] shrink-0 flex-col gap-2 rounded-xl p-2.5" style={{ background: "var(--bt-segment)" }}>
              <header className="flex flex-col gap-0.5 px-1.5 pb-1 pt-1">
                <span className="flex items-baseline gap-2">
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: DOT[column.tone] }} />
                  <h2 className="text-[14px] font-semibold">{column.name}</h2>
                  <span className="text-[12px] tabular-nums" style={{ color: "var(--bt-muted)" }}>({cards.length})</span>
                  {cards.length > 0 && <span data-stage-weighted className="ml-auto text-[12px] font-semibold tabular-nums" title="Sum of fee × chance over the deals that have both">{formatEurCompact(totals.weighted_eur)} weighted</span>}
                </span>
                {cards.length > 0 && (
                  <span className="flex items-center gap-2 pl-4 text-[11px] tabular-nums" style={{ color: "var(--bt-muted)" }}>
                    <span data-stage-total title="Total ticket value of the deals in this stage">{formatEurCompact(totals.value_eur)} ticket</span>
                    {totals.unsized > 0 && <span data-stage-unsized title="Deals without a fee or a chance are left out of the weighted total" style={{ color: "var(--bt-amber)" }}>{totals.unsized} unsized</span>}
                  </span>
                )}
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
