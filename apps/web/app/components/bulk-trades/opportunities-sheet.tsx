"use client";

import { CopyIdButton } from "./copy-id-button";
import { BusyRegion, Sh, ShBlock } from "./bt-shimmer";
import { Search, Flag } from "lucide-react";
import { SIDE_LABEL, sheetOptions, type SheetFilters, type SheetRow, type SheetTone } from "@/lib/bulk-sheet";
import { shortDate } from "@/lib/bulk-trade-details";
import { iconForLabel } from "./story-entry";
import { NextActionCell } from "./next-action-cell";
import { ErrorText } from "./trade-ui";

const TONE: Record<SheetTone, { dot: string; bg: string }> = {
  new: { dot: "var(--bt-muted)", bg: "var(--bt-segment)" },
  active: { dot: "var(--bt-blue)", bg: "var(--bt-blue-bg)" },
  waiting: { dot: "var(--bt-amber)", bg: "var(--bt-amber-bg)" },
  closing: { dot: "var(--bt-green)", bg: "var(--bt-green-bg)" },
  hold: { dot: "var(--bt-purple)", bg: "var(--bt-purple-bg)" },
};

const GRID = "md:grid-cols-[2.5rem_minmax(0,1.6fr)_minmax(7rem,1fr)_8.5rem_minmax(11rem,1.5fr)] lg:grid-cols-[2.5rem_minmax(0,1.6fr)_minmax(8rem,1fr)_8.5rem_5rem_minmax(12rem,1.5fr)]";
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

function ProgressChip({ row }: { row: SheetRow }) {
  const tone = TONE[row.tone];
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium" style={{ background: tone.bg }}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} />
      {row.progress}
    </span>
  );
}

/** A solid, coloured dot — bigger and simpler than a thin ring, reads at a glance without squinting at a number. */
function ScoreCircle({ score, size = 28 }: { score: number | null; size?: number }) {
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
function SideChip({ side }: { side: "buyer" | "seller" }) {
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

function SheetRowItem({ row, today, onOpen, onNext, loading = false }: { loading?: boolean; row: SheetRow; today: string; onOpen: (row: SheetRow) => void; onNext: (row: SheetRow, text: string | null) => Promise<void> }) {
  const latestIcon = row.latest?.kind ? iconForLabel(row.latest.kind) : Flag;
  return (
    <li aria-hidden={loading || undefined} onClick={() => { if (!loading) onOpen(row); }}
      className={`grid w-full cursor-pointer grid-cols-1 items-start gap-x-3 gap-y-2 px-2 py-3 text-left transition-colors hover:bg-[var(--bt-row-hover)] focus-within:bg-[var(--bt-row-hover)] ${GRID}`}>
      <span className="hidden md:block"><ShBlock on={loading} size={28}><ScoreCircle score={row.score} /></ShBlock></span>
      <span className="min-w-0">
        <span className="flex items-start gap-1">
          <button type="button" disabled={loading} title={row.title}
            className="line-clamp-2 min-w-0 flex-1 text-left text-[13px] font-medium leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"><Sh on={loading} chars={25}>{row.title}</Sh></button>
          {!loading && <SideChip side={row.side} />}
          {!loading && row.is_trade && row.progress !== "Trade" && <span className="text-[11px]" style={{ color: "var(--bt-green)" }}>Trade</span>}
          {!loading && <CopyIdButton id={row.id} />}
        </span>
        {(loading || row.company) && <span className="mt-0.5 block truncate text-[12px] md:hidden" style={{ color: "var(--bt-muted)" }}><Sh on={loading} chars={14}>{row.company}</Sh></span>}
        <span className="mt-1 inline-flex md:hidden"><ShBlock on={loading} size={28}><ScoreCircle score={row.score} /></ShBlock></span>
      </span>
      <span className="hidden min-w-0 truncate text-[13px] md:block" title={row.company ?? undefined} style={{ color: row.company ? undefined : "var(--bt-muted)" }}><Sh on={loading} chars={14}>{row.company ?? "—"}</Sh></span>
      <span><Sh on={loading} chars={11} round><ProgressChip row={row} /></Sh></span>
      <span className="hidden min-w-0 lg:block">
        {loading ? <Sh on chars={7} /> : row.latest ? (
          <IconDate icon={latestIcon} date={row.latest.at} title={[row.latest.kind, row.latest.label, row.latest.at ? shortDate(row.latest.at.slice(0, 10)) : null].filter(Boolean).join(" · ")} />
        ) : <span style={{ color: "var(--bt-muted)" }}>—</span>}
      </span>
      <span className="min-w-0">
        <NextActionCell loading={loading} value={row.next_action} due={row.next_due} owner={row.owner} today={today} onSave={(text) => onNext(row, text)} />
      </span>
    </li>
  );
}

const PLACEHOLDER_ROWS: SheetRow[] = Array.from({ length: 8 }, (_, index) => ({
  key: `loading:${index}`, id: "", kind: "demand", side: "buyer", title: "", company: null,
  company_id: null, category: null, progress: "", tone: "new", score: null,
  latest: null, next_action: null, next_due: null, owner: null, touched: null,
}));

export function OpportunitiesSheet({ rows, filters, shown, loading, error, today, onFilters, onOpen, onNext }: {
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
  const options = sheetOptions(rows);
  const set = (patch: Partial<SheetFilters>) => onFilters({ ...filters, ...patch });
  const filtered = filters.query.trim() !== "" || filters.side !== "all" || filters.progress !== "all" || filters.company !== "all" || filters.category !== "all";
  const sides = ["buyer", "seller"] as const;
  return (
    <BusyRegion busy={busy} label="Loading…" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <span className="sr-only">Search opportunities</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--bt-muted)" }} />
          <input type="search" value={filters.query} onChange={(event) => set({ query: event.target.value })}
            placeholder="Search buyers, offers, trades" className={`${field} w-full pl-9`} style={fieldStyle} />
        </label>
        {/* Starting point. Neither selected shows everything; pressing the selected one again clears it. */}
        <div role="group" aria-label="Starting point" className="flex rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {sides.map((value) => (
            <button key={value} type="button" aria-pressed={filters.side === value} onClick={() => set({ side: filters.side === value ? "all" : value })}
              className="h-8 shrink-0 rounded-md px-3 text-[13px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
              style={filters.side === value
                ? { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
                : { color: "var(--bt-text-2)" }}>
              {SIDE_LABEL[value]}
            </button>
          ))}
        </div>
        <Select label="Progress" value={filters.progress} options={options.progress} onChange={(progress) => set({ progress })} />
        <Select label="Company" value={filters.company} options={options.company} onChange={(company) => set({ company })} />
        <Select label="Category" value={filters.category} options={options.category} onChange={(category) => set({ category })} />
        {filtered && (
          <button type="button" className="h-9 rounded-lg px-2 text-[13px] underline" style={{ color: "var(--bt-text-2)" }}
            onClick={() => onFilters({ query: "", side: "all", progress: "all", company: "all", category: "all" })}>
            Clear filters
          </button>
        )}
      </div>

      <ErrorText error={error} />
      <p className="text-[12px]" style={{ color: "var(--bt-muted)" }} aria-live="polite">
        <Sh on={busy} chars={14}>{`${shown.length} of ${rows.length} open`}</Sh>
      </p>

      <div className="overflow-x-auto rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div className="md:min-w-[54rem] lg:min-w-[62rem]">
        <div aria-hidden="true" className={`hidden gap-x-3 border-b px-2 py-2 text-[12px] md:grid ${GRID}`} style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>
          <span>Score</span><span>Opportunity</span><span>Company</span><span>Progress</span><span className="hidden lg:block">Latest</span><span>Next action</span>
        </div>
        {displayRows.length > 0 ? (
          <ul className="divide-y divide-[var(--bt-divider)]">
            {displayRows.map((row) => <SheetRowItem key={row.key} row={row} loading={busy} today={today} onOpen={onOpen} onNext={onNext} />)}
          </ul>
        ) : (
          <p className="px-2 py-10 text-center text-[13px]" style={{ color: "var(--bt-muted)" }}>
            {error ? "The sheet could not load." : filtered ? "No opportunities match these filters." : "Nothing open right now."}
          </p>
        )}
        </div>
      </div>
    </BusyRegion>
  );
}
