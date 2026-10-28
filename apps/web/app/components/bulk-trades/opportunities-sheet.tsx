"use client";

import { CopyIdButton } from "./copy-id-button";
import { BusyRegion, Sh, ShBlock } from "./bt-shimmer";
import { Search, Flag } from "lucide-react";
import { NO_FILTERS, FEE_RATE, formatEurCompact, SHEET_SORTS, SIDE_LABEL, SORT_LABEL, WAITING_LABEL, sheetOptions, type SheetFilters, type SheetRow, type SheetSort, type SheetTone } from "@/lib/bulk-sheet";
import { shortDate } from "@/lib/bulk-trade-details";
import { iconForLabel } from "./story-entry";
import { NextActionCell } from "./next-action-cell";
import { ErrorText } from "./trade-ui";
import { DriverAvatar, Gap } from "./desk-bits";

const TONE: Record<SheetTone, { dot: string; bg: string }> = {
  new: { dot: "var(--bt-muted)", bg: "var(--bt-segment)" },
  active: { dot: "var(--bt-blue)", bg: "var(--bt-blue-bg)" },
  waiting: { dot: "var(--bt-amber)", bg: "var(--bt-amber-bg)" },
  closing: { dot: "var(--bt-green)", bg: "var(--bt-green-bg)" },
  hold: { dot: "var(--bt-purple)", bg: "var(--bt-purple-bg)" },
  warning: { dot: "var(--bt-red)", bg: "var(--bt-red-bg)" },
};

// Score | Opportunity | Ticket | Fee | Chance | Driver | Stage | Next action. Ticket, fee and chance join at lg.
const GRID = "md:grid-cols-[2.25rem_minmax(0,1.7fr)_2rem_8.5rem_minmax(11rem,1.4fr)] lg:grid-cols-[2.25rem_minmax(0,1.7fr)_4.5rem_4.5rem_3.5rem_2rem_8.5rem_minmax(12rem,1.5fr)]";
const field = "h-9 rounded-lg border bg-[var(--bt-surface)] px-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]";
const fieldStyle = { borderColor: "var(--bt-border)", color: "var(--bt-text)" };

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  // A value from a shared link may not exist in the data; keep it selectable so the filter stays visible.
  const all = value !== "all" && !options.includes(value) ? [...options, value] : options;
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}
      className={`${field} max-w-[11rem] min-w-0 flex-1 sm:flex-none`} style={fieldStyle}>
      <option value="all">{label}: all</option>
      {all.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  );
}

/** Whose move it is. "On us" is the one to act on, so it is the loud one; "them" stays quiet. */
export function WaitingBadge({ row, compact = false, large = false }: { row: Pick<SheetRow, "waiting_on" | "waiting_since">; compact?: boolean; large?: boolean }) {
  if (!row.waiting_on) return null;
  const us = row.waiting_on === "us";
  const since = row.waiting_since && !compact ? ` · ${shortDate(row.waiting_since)}` : "";
  return (
    <span data-waiting-on={row.waiting_on} title={row.waiting_since ? `${WAITING_LABEL[row.waiting_on]} since ${shortDate(row.waiting_since)}` : WAITING_LABEL[row.waiting_on]}
      className={`inline-flex w-fit shrink-0 items-center rounded-full border font-medium whitespace-nowrap ${large ? "h-9 rounded-none px-3 text-[13px] font-semibold" : "px-2 py-0.5 text-[11px]"}`}
      style={{ color: us ? "var(--bt-amber)" : "var(--bt-muted)", background: us ? "var(--bt-amber-bg)" : "transparent", borderColor: us ? "var(--bt-amber-border)" : "var(--bt-border)" }}>
      {WAITING_LABEL[row.waiting_on]}{since}
    </span>
  );
}

export function ProgressChip({ row }: { row: Pick<SheetRow, "tone" | "progress" | "held"> }) {
  const tone = TONE[row.tone];
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium" style={{ background: tone.bg }}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
      {row.progress}{row.held && <span style={{ color: "var(--bt-purple)" }}>· On hold</span>}
    </span>
  );
}

/** A solid, coloured dot — bigger and simpler than a thin ring, reads at a glance without squinting at a number. */
export function ScoreCircle({ score, size = 28 }: { score: number | null; size?: number }) {
  const tone = score == null
    ? { bg: "var(--bt-segment)", fg: "var(--bt-muted)" }
    : score >= 80 ? { bg: "var(--bt-green-bg)", fg: "var(--bt-green)" }
    : score >= 60 ? { bg: "var(--bt-amber-bg)", fg: "var(--bt-amber)" }
    : { bg: "var(--bt-segment)", fg: "var(--bt-muted)" };
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums"
      style={{ width: size, height: size, background: tone.bg, color: tone.fg }}
      role="img" aria-label={score == null ? "Not scored" : `Score ${score} out of 100`}>
      {score ?? "–"}
    </span>
  );
}

/** Which way the work runs: a buyer's need or a seller's stock. */
export function SideChip({ side }: { side: "buyer" | "seller" }) {
  const buying = side === "buyer";
  return (
    <span className="mt-px shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium leading-4"
      style={{ background: buying ? "var(--bt-amber-bg)" : "var(--bt-green-bg)", color: buying ? "var(--bt-amber)" : "var(--bt-green)" }}
      title={buying ? "Demand: a buyer's need" : "Supply: a seller's stock"}>
      {buying ? "Demand" : "Supply"}
    </span>
  );
}

/** Compact: just the icon for what happened and the date, full text on hover. */
function IconDate({ icon: Icon, date, title, tone }: { icon: typeof Flag; date: string | null; title: string; tone?: string }) {
  if (!date) return <span title="Nothing recorded" style={{ color: "var(--bt-muted)" }}>—</span>;
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <Icon size={13} aria-hidden style={{ color: tone ?? "var(--bt-muted)" }} />
      <span className="text-[12px] whitespace-nowrap" style={{ color: "var(--bt-muted)" }}>{shortDate(date.slice(0, 10))}</span>
    </span>
  );
}

function SheetRowItem({ row, today, onOpen, onNext, loading = false, showSide = true }: { loading?: boolean; showSide?: boolean; row: SheetRow; today: string; onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void> }) {
  const latestIcon = row.latest?.kind ? iconForLabel(row.latest.kind) : Flag;
  const num = "hidden min-w-0 text-[13px] tabular-nums lg:block";
  return (
    <li aria-hidden={loading || undefined} onClick={() => { if (!loading) onOpen(row); }}
      className={`grid w-full cursor-pointer grid-cols-1 items-start gap-x-3 gap-y-2 px-2 py-2.5 text-left transition-colors hover:bg-[var(--bt-row-hover)] focus-within:bg-[var(--bt-row-hover)] ${GRID}`}>
      <span className="hidden md:block"><ShBlock on={loading} size={28}><ScoreCircle score={row.score} /></ShBlock></span>
      <span className="min-w-0">
        <span className="flex items-start gap-1">
          <button type="button" disabled={loading} title={row.title}
            className="line-clamp-2 min-w-0 flex-1 text-left text-[13px] font-semibold leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"><Sh on={loading} chars={25}>{row.title}</Sh></button>
          {!loading && showSide && <SideChip side={row.side} />}
          {!loading && row.is_trade && <span className="text-[11px]" style={{ color: "var(--bt-green)" }}>Trade</span>}
          {!loading && <CopyIdButton id={row.id} />}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px]" style={{ color: "var(--bt-muted)" }}>
          <span className="min-w-0 truncate" title={row.company ?? undefined}><Sh on={loading} chars={14}>{row.company ?? "No company"}</Sh></span>
          {!loading && row.latest && <span className="hidden shrink-0 md:inline-flex"><IconDate icon={latestIcon} date={row.latest.at} title={[row.latest.kind, row.latest.label, row.latest.at ? shortDate(row.latest.at.slice(0, 10)) : null].filter(Boolean).join(" · ")} /></span>}
          {!loading && <span className="md:hidden"><DriverAvatar owner={row.owner} size={18} /></span>}
        </span>
        <span className="mt-1 inline-flex md:hidden"><ShBlock on={loading} size={28}><ScoreCircle score={row.score} /></ShBlock></span>
      </span>
      <span data-ticket className={num} title={row.value_eur != null ? `Approximate ${row.side === "buyer" ? "deal" : "stock"} value, EUR ${row.value_eur.toLocaleString("en-GB")}` : "No size recorded: open it to add quantity and price"}>
        <Sh on={loading} chars={5}>{row.value_eur != null ? formatEurCompact(row.value_eur) : <Gap>Add size</Gap>}</Sh></span>
      <span data-fee className={num} title={row.fee_eur != null ? `${row.fee_is_override ? "Fee set by hand" : `Our fee at ${FEE_RATE * 100}% of value`}, EUR ${row.fee_eur.toLocaleString("en-GB")}` : "No fee: set one, or add a size"}>
        <Sh on={loading} chars={5}>{row.fee_eur != null ? formatEurCompact(row.fee_eur) : <Gap>Set fee</Gap>}</Sh></span>
      <span data-chance className={num} title={row.likelihood != null ? "Chance this deal completes" : "Chance not set"}>
        <Sh on={loading} chars={3}>{row.likelihood != null ? `${row.likelihood}%` : <Gap>Set %</Gap>}</Sh></span>
      <span data-owner className="hidden md:block">{loading ? <ShBlock on size={24}><span /></ShBlock> : <DriverAvatar owner={row.owner} />}</span>
      <span className="flex min-w-0 flex-col items-start gap-1"><Sh on={loading} chars={11} round><ProgressChip row={row} /></Sh>{!loading && <WaitingBadge row={row} />}</span>
      <span className="min-w-0">
        <NextActionCell loading={loading} value={row.next_action} due={row.next_due} today={today} onSave={(text) => onNext(row, text)} />
      </span>
    </li>
  );
}

/** True when the filter bar narrows the rows. The driver is a page choice, and a locked side is the tab itself. */
function isFiltered(filters: SheetFilters, sideLocked: boolean): boolean {
  return filters.query.trim() !== "" || (!sideLocked && filters.side !== "all") || filters.progress !== "all" || filters.company !== "all" || filters.category !== "all" || filters.waiting !== "all";
}

const PLACEHOLDER_ROWS: SheetRow[] = Array.from({ length: 8 }, (_, index) => ({
  key: `loading:${index}`, id: "", kind: "demand", side: "buyer", title: "", company: null,
  company_id: null, category: null, progress: "New", tone: "new", score: null,
  latest: null, next_action: null, next_due: null, waiting_on: null, waiting_since: null, owner: null, touched: null,
}));

/** Search, starting point and menus; shared by the list and the board. */
export function SheetFilterBar({ rows, filters, onFilters, hideProgress = false, hideSide = false, stages, sort, onSort }: {
  rows: SheetRow[]; filters: SheetFilters; onFilters: (next: SheetFilters) => void; hideProgress?: boolean;
  /** The sheet is locked to one kind (Requests or Supply): no Buying/Selling toggle. */
  hideSide?: boolean;
  /** The Progress choices; defaults to the stages present in the rows. */
  stages?: readonly string[];
  sort?: SheetSort; onSort?: (next: SheetSort) => void;
}) {
  const options = sheetOptions(rows);
  const set = (patch: Partial<SheetFilters>) => onFilters({ ...filters, ...patch });
  const filtered = isFiltered(filters, hideSide);
  const sides = ["buyer", "seller"] as const;
  const stageCount = (stage: string) => rows.filter((row) => row.progress === stage).length;
  const chip = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]`;
  const chipStyle = (on: boolean) => on ? { background: "var(--bt-text)", borderColor: "var(--bt-text)", color: "var(--bt-surface)" } : { background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" };
  return (
    <div className="flex flex-col gap-2.5">
      {!hideProgress && stages && (
        <div role="group" aria-label="Stage" className="flex gap-1.5 overflow-x-auto pb-0.5">
          {(["all", ...stages] as string[]).map((stage) => {
            const on = filters.progress === stage;
            return (
              <button key={stage} type="button" aria-pressed={on} onClick={() => set({ progress: on && stage !== "all" ? "all" : stage })} className={chip} style={chipStyle(on)}>
                {stage === "all" ? "All" : stage}
                <span className="tabular-nums" style={{ color: on ? "inherit" : "var(--bt-muted)", opacity: on ? 0.75 : 1 }}>{stage === "all" ? rows.length : stageCount(stage)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <span className="sr-only">Search opportunities</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--bt-muted)" }} />
          <input type="search" value={filters.query} onChange={(event) => set({ query: event.target.value })}
            placeholder="Search buyers, offers, trades" className={`${field} w-full pl-9`} style={fieldStyle} />
        </label>
        {/* Starting point. Neither selected shows everything; pressing the selected one again clears it. */}
        {!hideSide && <div role="group" aria-label="Starting point" className="flex rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {sides.map((value) => (
            <button key={value} type="button" aria-pressed={filters.side === value} onClick={() => set({ side: filters.side === value ? "all" : value })}
              className="h-8 shrink-0 rounded-md px-3 text-[13px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
              style={filters.side === value
                ? { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
                : { color: "var(--bt-text-2)" }}>
              {SIDE_LABEL[value]}
            </button>
          ))}
        </div>}
        {!hideProgress && !stages && <Select label="Progress" value={filters.progress} options={options.progress} onChange={(progress) => set({ progress })} />}
        <Select label="Company" value={filters.company} options={options.company} onChange={(company) => set({ company })} />
        <Select label="Category" value={filters.category} options={options.category} onChange={(category) => set({ category })} />
        <select aria-label="Waiting on" value={filters.waiting} onChange={(event) => set({ waiting: event.target.value as SheetFilters["waiting"] })}
          className={`${field} max-w-[11rem] min-w-0 flex-1 sm:flex-none`} style={fieldStyle}>
          <option value="all">Waiting on: all</option>
          <option value="us">Waiting on: us</option>
          <option value="them">Waiting on: them</option>
        </select>
        {onSort && (
          <select aria-label="Sort by" value={sort ?? "newest"} onChange={(event) => onSort(event.target.value as SheetSort)}
            className={`${field} max-w-[13rem] min-w-0 flex-1 sm:flex-none`} style={fieldStyle}>
            {SHEET_SORTS.map((value) => <option key={value} value={value}>{`Sort: ${SORT_LABEL[value]}`}</option>)}
          </select>
        )}
        {filtered && (
          <button type="button" className="h-9 rounded-lg px-2 text-[13px] underline" style={{ color: "var(--bt-text-2)" }}
            onClick={() => onFilters({ ...NO_FILTERS, owner: filters.owner, side: hideSide ? filters.side : "all" })}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

export function OpportunitiesSheet({ rows, filters, shown, loading, error, today, sort, onSort, onFilters, onOpen, onNext, hideSide = false, stages }: {
  hideSide?: boolean;
  stages?: readonly string[];
  sort?: SheetSort;
  onSort?: (next: SheetSort) => void;
  rows: SheetRow[];
  shown: SheetRow[];
  filters: SheetFilters;
  loading: boolean;
  error: string | null;
  today: string;
  onFilters: (next: SheetFilters) => void;
  onOpen: (row: SheetRow) => void;
  onNext: (row: SheetRow, text: string | null) => Promise<void>;
}) {
  const busy = loading && !rows.length;
  const displayRows = busy ? PLACEHOLDER_ROWS : shown;
  const filtered = isFiltered(filters, hideSide);
  return (
    <BusyRegion busy={busy} label="Loading…" className="flex flex-col gap-4">
      <SheetFilterBar rows={rows} filters={filters} onFilters={onFilters} sort={sort} onSort={onSort} hideSide={hideSide} stages={stages} />

      <ErrorText error={error} />
      <p className="text-[12px]" style={{ color: "var(--bt-muted)" }} aria-live="polite">
        <Sh on={busy} chars={14}>{`${shown.length} of ${rows.length} live`}</Sh>
      </p>

      <div className="overflow-x-auto rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="md:min-w-[48rem] lg:min-w-[62rem]">
        <div aria-hidden="true" className={`hidden gap-x-3 border-b px-2 py-2 text-[12px] md:grid ${GRID}`} style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>
          <span>Score</span><span>Opportunity</span><span className="hidden lg:block" title="Approximate value of the deal or the stock">Ticket</span><span className="hidden lg:block" title={`${FEE_RATE * 100}% of the ticket unless set`}>Fee</span><span className="hidden lg:block" title="Chance the deal completes">Chance</span><span>Driver</span><span>Stage</span><span>Next action</span>
        </div>
        {displayRows.length > 0 ? (
          <ul className="divide-y divide-[var(--bt-divider)]">
            {displayRows.map((row) => <SheetRowItem key={row.key} row={row} loading={busy} today={today} onOpen={onOpen} onNext={onNext} showSide={!hideSide} />)}
          </ul>
        ) : (
          <p className="px-2 py-10 text-center text-[13px]" style={{ color: "var(--bt-muted)" }}>
            {error ? "The sheet could not load." : filtered ? "No opportunities match these filters." : "Nothing live right now."}
          </p>
        )}
        </div>
      </div>
    </BusyRegion>
  );
}
