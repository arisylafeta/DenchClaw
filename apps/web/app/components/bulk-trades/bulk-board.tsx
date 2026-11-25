"use client";

import { useEffect, useRef, useState } from "react";
import { FEE_RATE, formatEurCompact, type SheetRow, type SheetTone } from "@/lib/bulk-sheet";
import { dealTotals, isBoardRequest } from "@/lib/bulk-desk";
import type { ListingStage } from "@/lib/bulk-listing";
import { ABANDON_REASONS, abandonReasonLabel, type AbandonReason } from "@/lib/bulk-abandon";
import { dayMonth } from "@/lib/next-action-dates";
import { BusyRegion } from "./bt-shimmer";
import { ScoreCircle, SideChip, WaitingBadge } from "./opportunities-sheet";
import { DriverAvatar, DueText, Gap } from "./desk-bits";

type ColumnName = "Requests" | ListingStage | "Abandoned";

/** The pipeline: open bulk requests, then the deal stages (bulk_listing_stage; a listing moves on by what happens to its
 * offers, in the Offers tab), then Abandoned. The only drags are into Abandoned (close as lost, with a reason) and back out
 * of it (reopen). */
const COLUMNS: { name: ColumnName; tone: SheetTone; hint: string }[] = [
  { name: "Requests", tone: "active", hint: "Bulk requests not offered yet" },
  { name: "Offered", tone: "waiting", hint: "Put to a counterparty" },
  { name: "Negotiating", tone: "waiting", hint: "Terms under discussion" },
  { name: "Agreed", tone: "closing", hint: "Contract out, signed or invoiced" },
  { name: "Paid", tone: "closing", hint: "Payment received" },
  { name: "Delivered", tone: "closing", hint: "Delivered" },
  { name: "Abandoned", tone: "new", hint: "Lost or stopped. Drag a card here to close it, or back out to reopen it" },
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

type DragHandlers = { onDragStart: () => void; onDragEnd: () => void };

function Card({ row, today, onOpen, drag }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void; drag?: DragHandlers }) {
  const abandoned = row.abandoned;
  return (
    <li draggable={!!drag} data-card={row.key}
      onDragStart={drag ? (event) => { event.dataTransfer?.setData("text/plain", row.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; drag.onDragStart(); } : undefined}
      onDragEnd={drag?.onDragEnd}>
      <button type="button" onClick={() => onOpen(row)}
        className={`flex w-full flex-col gap-2 rounded-[10px] border p-3 text-left transition-colors hover:border-[var(--bt-border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)] ${drag ? "cursor-grab active:cursor-grabbing" : ""}`}
        style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", opacity: abandoned ? 0.8 : undefined }}>
        <span className="flex items-start gap-2">
          <ScoreCircle score={row.score} size={24} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <SideChip side={row.side} />
              {row.company && <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">{row.company}</span>}
            </span>
            <span className="text-[12px] font-medium leading-snug [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden" style={{ color: "var(--bt-muted)" }}>{row.title}</span>
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
        {abandoned ? (
          <span data-card-abandoned className="flex items-center justify-between gap-2 border-t pt-2 text-[12px] leading-snug" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
            <span className="truncate font-medium">{abandonReasonLabel(row.kind, abandoned.reason)}</span>
            {abandoned.at && <span className="whitespace-nowrap tabular-nums" style={{ color: "var(--bt-muted)" }}>{dayMonth(abandoned.at.slice(0, 10))}</span>}
          </span>
        ) : (
          <span className="flex flex-col gap-1 border-t pt-2 text-[12px] leading-snug" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>
            <span className="[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden" style={row.next_action ? undefined : { color: "var(--bt-amber)", fontWeight: 500 }}>{row.next_action ?? "No next action"}</span>
            {(row.next_action && row.next_due) || row.waiting_on ? (
              <span className="flex items-center justify-between gap-2">
                {row.next_action ? <DueText due={row.next_due} today={today} /> : <span />}
                <WaitingBadge row={row} compact />
              </span>
            ) : null}
          </span>
        )}
      </button>
    </li>
  );
}

/** Dropped on Abandoned: pick why it stopped (and an optional note) before the listing closes. */
function AbandonPrompt({ row, onConfirm, onCancel }: { row: SheetRow; onConfirm: (reason: AbandonReason, note: string) => Promise<void>; onCancel: () => void }) {
  const [reason, setReason] = useState<AbandonReason | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLButtonElement>(null);
  // The dragged card left its column, so focus would fall to the page: put it on the first reason.
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !saving) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reason || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(reason, note.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move it to Abandoned.");
      setSaving(false);
    }
  }
  return (
    <form role="dialog" aria-label="Abandon deal" onSubmit={submit} className="flex flex-col gap-2 rounded-[10px] border p-3" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border-strong)" }}>
      <span className="flex flex-col gap-0.5">
        <span className="text-[13px] font-semibold">Why did it stop?</span>
        <span className="truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>{row.company ?? row.title}</span>
      </span>
      <span role="radiogroup" aria-label="Reason" className="flex flex-wrap gap-1.5">
        {ABANDON_REASONS[row.kind].map((item, index) => {
          const on = reason === item.value;
          return (
            <button key={item.value} ref={index === 0 ? first : undefined} type="button" role="radio" aria-checked={on} onClick={() => setReason(item.value)}
              className="rounded-full border px-2.5 py-1 text-[12px] font-medium"
              style={on ? { background: "var(--bt-text)", color: "var(--bt-surface)", borderColor: "var(--bt-text)" } : { borderColor: "var(--bt-border)", color: "var(--bt-text-2)" }}>
              {item.label}
            </button>
          );
        })}
      </span>
      <textarea aria-label="Note" placeholder="Note (optional)" rows={2} value={note} onChange={(event) => setNote(event.target.value)}
        className="w-full resize-none rounded-md border px-2 py-1.5 text-[12px] outline-none focus:border-[var(--bt-border-strong)]" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }} />
      {error && <p role="alert" className="text-[12px]" style={{ color: "var(--bt-red)" }}>{error}</p>}
      <span className="flex justify-end gap-2">
        <button type="button" disabled={saving} onClick={onCancel} className="rounded-md px-2.5 py-1 text-[12px] font-medium hover:bg-black/5">Cancel</button>
        <button type="submit" disabled={!reason || saving} className="rounded-md px-2.5 py-1 text-[12px] font-semibold disabled:opacity-40"
          style={{ background: "var(--bt-text)", color: "var(--bt-surface)" }}>{saving ? "Moving…" : "Abandon"}</button>
      </span>
    </form>
  );
}

type Props = {
  /** The Deals tab's rows: open requests and listings at a deal stage. */
  shown: SheetRow[];
  /** Closed listings for the Abandoned column, newest first. */
  abandoned?: SheetRow[];
  loading: boolean;
  error: string | null;
  today: string;
  onOpen: (row: SheetRow) => void;
  /** Dropped on Abandoned with a reason. Rejects with the message to show. Without it and onReopen nothing drags. */
  onAbandon?: (row: SheetRow, reason: AbandonReason, note: string) => Promise<void>;
  /** Dragged out of Abandoned. */
  onReopen?: (row: SheetRow) => void;
};

export function BulkBoard({ shown, abandoned = [], loading, error, today, onOpen, onAbandon, onReopen }: Props) {
  const [dragging, setDragging] = useState<{ row: SheetRow; from: "live" | "abandoned" } | null>(null);
  const [over, setOver] = useState<ColumnName | null>(null);
  const [asking, setAsking] = useState<SheetRow | null>(null);
  const canDrag = !!onAbandon && !!onReopen;
  const cardsFor = (name: ColumnName) => name === "Requests" ? shown.filter(isBoardRequest)
    : name === "Abandoned" ? abandoned.filter((row) => row.key !== asking?.key)
    : shown.filter((row) => row.progress === name);
  /** Into Abandoned from any other column; out of Abandoned into any other column (the card lands where its stage says). */
  const accepts = (name: ColumnName) => !!dragging && !asking && (dragging.from === "abandoned" ? name !== "Abandoned" : name === "Abandoned");
  function drop(name: ColumnName) {
    const moved = dragging;
    setDragging(null);
    setOver(null);
    if (!moved || !accepts(name)) return;
    if (name === "Abandoned") setAsking(moved.row);
    else onReopen?.(moved.row);
  }
  return (
    <BusyRegion busy={loading} label="Loading…">
      {error && <p className="text-[13px]" role="alert" style={{ color: "var(--bt-red)" }}>{error}</p>}
      <div className="flex gap-3 overflow-x-auto pb-3" aria-label="Pipeline">
        {COLUMNS.map((column) => {
          const cards = cardsFor(column.name);
          const totals = dealTotals(cards);
          const isAbandoned = column.name === "Abandoned";
          const target = accepts(column.name);
          return (
            <section key={column.name} aria-label={column.name} title={column.hint} data-drop-target={target || undefined}
              onDragOver={target ? (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "move"; if (over !== column.name) setOver(column.name); } : undefined}
              onDragLeave={target ? (event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); } : undefined}
              onDrop={target ? (event) => { event.preventDefault(); drop(column.name); } : undefined}
              className="flex w-[17.5rem] shrink-0 flex-col gap-2 rounded-xl p-2.5 outline-2 outline-offset-[-2px] transition-[outline-color]"
              style={{ background: "var(--bt-segment)", outlineStyle: target ? "dashed" : "none", outlineColor: over === column.name ? "var(--bt-text-2)" : "var(--bt-border-strong)" }}>
              <header className="flex flex-col gap-0.5 px-1.5 pb-1 pt-1">
                <span className="flex items-baseline gap-2">
                  <span aria-hidden="true" className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: DOT[column.tone] }} />
                  <h2 className="text-[14px] font-semibold">{column.name}</h2>
                  <span className="text-[12px] tabular-nums" style={{ color: "var(--bt-muted)" }}>({cards.length})</span>
                  {!isAbandoned && cards.length > 0 && <span data-stage-weighted className="ml-auto text-[12px] font-semibold tabular-nums" title="Sum of fee × chance over the deals that have both">{formatEurCompact(totals.weighted_eur)} weighted</span>}
                </span>
                {cards.length > 0 && (
                  <span className="flex items-center gap-2 pl-4 text-[11px] tabular-nums" style={{ color: "var(--bt-muted)" }}>
                    <span data-stage-total title={isAbandoned ? "Total ticket value of the abandoned deals shown" : "Total ticket value of the deals in this stage"}>{formatEurCompact(totals.value_eur)} ticket</span>
                    {!isAbandoned && totals.unsized > 0 && <span data-stage-unsized title="Deals without a fee or a chance are left out of the weighted total" style={{ color: "var(--bt-amber)" }}>{totals.unsized} unsized</span>}
                  </span>
                )}
              </header>
              {isAbandoned && asking && onAbandon && (
                <AbandonPrompt key={asking.key} row={asking} onCancel={() => setAsking(null)}
                  onConfirm={async (reason, note) => { await onAbandon(asking, reason, note); setAsking(null); }} />
              )}
              <ul className="flex flex-col gap-2">
                {cards.map((row) => <Card key={row.key} row={row} today={today} onOpen={onOpen}
                  drag={canDrag ? { onDragStart: () => setDragging({ row, from: isAbandoned ? "abandoned" : "live" }), onDragEnd: () => { setDragging(null); setOver(null); } } : undefined} />)}
              </ul>
              {!cards.length && !(isAbandoned && asking) && <p className="px-1.5 pb-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>{isAbandoned && canDrag ? "Drag a card here when a deal stops" : "Nothing here"}</p>}
            </section>
          );
        })}
      </div>
    </BusyRegion>
  );
}
