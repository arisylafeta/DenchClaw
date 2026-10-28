"use client";

import { useMemo } from "react";
import { boardRows, dealTotals, deskCounts, EUR_PER_GBP, quarterTarget, todayGroups, WIN_RATE, type TodayGroupKey } from "@/lib/bulk-desk";
import { formatEurCompact, type SheetRow } from "@/lib/bulk-sheet";
import type { DealOwner } from "@/lib/bulk-owner";
import { isBoardStage } from "@/lib/bulk-listing";
import { BusyRegion, Sh } from "./bt-shimmer";
import { NextActionCell } from "./next-action-cell";
import { ProgressChip } from "./opportunities-sheet";
import { DriverAvatar, DueText } from "./desk-bits";
import { ErrorText } from "./trade-ui";

/** Whole thousands for the target, e.g. £27k, €31k. */
const roundK = (symbol: string, value: number) => `${symbol}${Math.round(value / 1000).toLocaleString("en-GB")}k`;
const percent = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0);

function Meter({ label, hint, value, of, focal = false, loading }: { label: string; hint: string; value: number; of: number; focal?: boolean; loading: boolean }) {
  const pct = percent(value, of);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[13px] font-medium">{label} <span className="font-normal" style={{ color: "var(--bt-muted)" }}>{hint}</span></span>
        <span className="text-[13px] tabular-nums">
          <Sh on={loading} chars={12}><span className="font-semibold">{formatEurCompact(value)}</span> <span style={{ color: "var(--bt-muted)" }}>of {roundK("€", of)} · {pct}%</span></Sh>
        </span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={loading ? undefined : pct}
        className="h-2 overflow-hidden rounded-full" style={{ background: "var(--bt-segment)" }}>
        {!loading && <div className="h-full rounded-full" style={{ width: `${pct}%`, background: focal ? "var(--bt-accent)" : "var(--bt-border-strong)" }} />}
      </div>
    </div>
  );
}

/** Open deals on the Board against the quarter target: their fees weighted by chance, and in full against what a
 * 20% win rate needs. Not take banked this quarter: there is no quarter accounting yet. */
export function QuarterTarget({ rows, owner, loading, onOpenBoard }: { rows: SheetRow[]; owner: DealOwner | "all"; loading: boolean; onOpenBoard: () => void }) {
  const target = quarterTarget(owner);
  if (!target) {
    return <p data-no-target className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Targets are set for Alex and Sean.</p>;
  }
  const totals = dealTotals(boardRows(rows));
  return (
    <section aria-label="Pipeline against quarter target" className="flex flex-col gap-3 rounded-xl border p-4" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[14px] font-semibold">Pipeline against quarter target{owner !== "all" && <span className="font-normal" style={{ color: "var(--bt-muted)" }}> · {owner}</span>}</h2>
        <span className="text-[14px] font-semibold tabular-nums" title={`Approx. at €${EUR_PER_GBP} to £1`}>
          {roundK("£", target.gbp)} <span className="font-normal" style={{ color: "var(--bt-muted)" }}>(≈ {roundK("€", target.eur)})</span>
        </span>
      </header>
      <Meter label="Weighted fees" hint="fee × chance" value={totals.weighted_eur} of={target.eur} focal loading={loading} />
      <Meter label="All fees" hint={`needed at a ${WIN_RATE * 100}% win rate`} value={totals.fee_eur} of={target.needed_eur} loading={loading} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
          Open deals on the Board, Offered to Delivered, not fees banked this quarter.{owner === "all" && " Includes deals with no owner."} Euro amounts approx. at €{EUR_PER_GBP} to £1.
        </p>
        {!loading && totals.unsized > 0 && (
          <button type="button" onClick={onOpenBoard} data-unsized-nudge
            className="inline-flex h-8 items-center rounded-lg border px-3 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
            style={{ color: "var(--bt-amber)", background: "var(--bt-amber-bg)", borderColor: "var(--bt-amber-border)" }}>
            {totals.unsized} {totals.unsized === 1 ? "deal needs" : "deals need"} a fee or chance
          </button>
        )}
      </div>
    </section>
  );
}

const GROUP_TONE: Partial<Record<TodayGroupKey, string>> = { overdue: "var(--bt-red)", today: "var(--bt-blue)" };

/** What the row is: a request, a supply lot, or a deal once it is offered. */
const kindLabel = (row: SheetRow) => (isBoardStage(row.progress) ? "Deal" : row.kind === "demand" ? "Request" : "Supply");

/** One task: the next action to do, where it belongs underneath, when it is due and who drives it on the right. */
function ActionRow({ row, today, onOpen, onNext }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void> }) {
  return (
    <li onClick={() => onOpen(row)}
      className="flex cursor-pointer items-start gap-3 px-4 py-3 transition-colors hover:bg-[var(--bt-row-hover)] focus-within:bg-[var(--bt-row-hover)]">
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="min-w-0"><NextActionCell large value={row.next_action} due={null} today={today} onSave={(text) => onNext(row, text)} /></span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <span>{kindLabel(row)}</span><span aria-hidden="true">·</span>
          <button type="button" title={row.title} className="min-w-0 max-w-full truncate text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]">
            {row.company ? `${row.company}, ` : ""}{row.title}
          </button>
          {row.likelihood != null && <><span aria-hidden="true">·</span><span>{row.likelihood}% chance</span></>}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span className="flex items-center gap-2">
          <DueText due={row.next_action ? row.next_due : null} today={today} />
          <DriverAvatar owner={row.owner} size={22} />
        </span>
        <ProgressChip row={row} />
      </span>
    </li>
  );
}

/** "Alex has 6 requests and 4 supply lots; 3 are deals. 9 next actions: 1 overdue, 3 due today." Same counts as the tabs. */
function summary(rows: SheetRow[], owner: DealOwner | "all", groups: { key: TodayGroupKey; rows: SheetRow[] }[]): string {
  const counts = deskCounts(rows);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const count = (key: TodayGroupKey) => groups.find((group) => group.key === key)?.rows.length ?? 0;
  const actions = rows.filter((row) => row.next_action).length;
  const urgent = [count("overdue") && `${count("overdue")} overdue`, count("today") && `${count("today")} due today`].filter(Boolean).join(", ");
  const deals = counts.deals ? `; ${counts.deals === 1 ? "1 is a deal" : `${counts.deals} are deals`}` : "";
  return `${owner === "all" ? "The team has" : `${owner} has`} ${plural(counts.requests, "request", "requests")} and ${plural(counts.supply, "supply lot", "supply lots")}${deals}. `
    + `${plural(actions, "next action", "next actions")}${urgent ? `: ${urgent}` : ""}.`;
}

/** Today: the quarter target, then every open listing's next action by when it is due. Nothing else. */
export function TodayView({ rows, owner, loading, error, today, onOpen, onNext, onOpenBoard }: {
  rows: SheetRow[]; owner: DealOwner | "all"; loading: boolean; error: string | null; today: string;
  onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void>; onOpenBoard: () => void;
}) {
  const groups = useMemo(() => todayGroups(rows, today), [rows, today]);
  const busy = loading && !rows.length;
  return (
    <BusyRegion busy={busy} label="Loading…" className="flex flex-col gap-4">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })}</h2>
        {(busy || (!error && rows.length > 0)) && <p data-today-summary className="text-[13px]" style={{ color: "var(--bt-text-2)" }}><Sh on={busy} chars={48}>{summary(rows, owner, groups)}</Sh></p>}
      </div>
      <QuarterTarget rows={rows} owner={owner} loading={busy} onOpenBoard={onOpenBoard} />
      <ErrorText error={error} />
      <section aria-label="Next actions" className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <header className="flex items-baseline justify-between gap-2 border-b px-4 py-3" style={{ borderColor: "var(--bt-divider)" }}>
          <h2 className="text-[15px] font-semibold">Next actions</h2>
        </header>
        {busy ? (
          <ul className="divide-y divide-[var(--bt-divider)]">
            {Array.from({ length: 5 }, (_, index) => <li key={index} className="flex flex-col gap-1.5 px-4 py-3 text-[13px]"><Sh on chars={30 + (index % 3) * 8} /><span className="text-[12px]"><Sh on chars={22} /></span></li>)}
          </ul>
        ) : !rows.length ? (
          <p className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--bt-muted)" }}>{error ? "The list could not load." : "Nothing open right now."}</p>
        ) : groups.filter((group) => group.rows.length).map((group) => (
          <section key={group.key} aria-label={group.label} data-group={group.key}>
            <h3 className="border-b px-4 py-1.5 text-[12px] font-semibold" style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)", color: GROUP_TONE[group.key] ?? "var(--bt-text-2)" }}>
              {group.label} <span className="font-normal tabular-nums" style={{ color: "var(--bt-muted)" }}>({group.rows.length})</span>
            </h3>
            <ul className="divide-y divide-[var(--bt-divider)] border-b" style={{ borderColor: "var(--bt-divider)" }}>
              {group.rows.map((row) => <ActionRow key={row.key} row={row} today={today} onOpen={onOpen} onNext={onNext} />)}
            </ul>
          </section>
        ))}
      </section>
    </BusyRegion>
  );
}
