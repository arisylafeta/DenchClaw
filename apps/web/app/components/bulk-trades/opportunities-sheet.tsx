"use client";

import { Search } from "lucide-react";
import { SIDE_LABEL, sheetOptions, type SheetFilters, type SheetRow, type SheetTone } from "@/lib/bulk-sheet";
import { shortDate } from "@/lib/bulk-trade-details";
import { ErrorText } from "./trade-ui";

const TONE: Record<SheetTone, { dot: string; bg: string }> = {
  new: { dot: "var(--bt-muted)", bg: "var(--bt-segment)" },
  active: { dot: "var(--bt-blue)", bg: "var(--bt-blue-bg)" },
  waiting: { dot: "var(--bt-amber)", bg: "var(--bt-amber-bg)" },
  closing: { dot: "var(--bt-green)", bg: "var(--bt-green-bg)" },
  hold: { dot: "var(--bt-purple)", bg: "var(--bt-purple-bg)" },
};

const KIND_LABEL = { demand: "Demand", supply: "Offer", trade: "Trade" } as const;
const GRID = "md:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_9rem_minmax(0,1.5fr)] lg:grid-cols-[minmax(0,2fr)_minmax(0,1.1fr)_9rem_minmax(0,1.6fr)_minmax(0,1.5fr)]";
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

function SheetRowItem({ row, today, onOpen }: { row: SheetRow; today: string; onOpen: (row: SheetRow) => void }) {
  const overdue = !!row.next_due && row.next_due < today;
  const meta = [row.owner, row.next_due ? `${overdue ? "overdue " : "due "}${shortDate(row.next_due)}` : null].filter(Boolean).join(" · ");
  return (
    <li>
      <button type="button" onClick={() => onOpen(row)}
        className={`grid w-full grid-cols-1 items-start gap-x-4 gap-y-2 px-4 py-3 text-left transition-colors hover:bg-[var(--bt-row-hover)] focus-visible:bg-[var(--bt-row-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--bt-text-2)] ${GRID}`}>
        <span className="min-w-0">
          <span className="line-clamp-2 text-[14px] font-medium leading-snug">{row.title}</span>
          <span className="mt-0.5 block text-[12px]" style={{ color: "var(--bt-muted)" }}>
            {KIND_LABEL[row.kind]} · {SIDE_LABEL[row.side]}
            {row.company && <span className="md:hidden"> · {row.company}</span>}
          </span>
        </span>
        <span className="hidden min-w-0 truncate text-[13px] md:block" style={{ color: row.company ? undefined : "var(--bt-muted)" }}>{row.company ?? "No company recorded"}</span>
        <span><ProgressChip row={row} /></span>
        <span className="hidden min-w-0 text-[13px] lg:block">
          {row.latest ? (
            <>
              <span className="line-clamp-2">{row.latest.label}</span>
              {row.latest.at && <span className="block text-[12px]" style={{ color: "var(--bt-muted)" }}>{shortDate(row.latest.at.slice(0, 10))}</span>}
            </>
          ) : <span style={{ color: "var(--bt-muted)" }}>Nothing recorded</span>}
        </span>
        <span className="min-w-0 text-[13px]">
          {row.next_action ? (
            <>
              <span className="line-clamp-2">{row.next_action}</span>
              {meta && <span className="block text-[12px]" style={{ color: overdue ? "var(--bt-red)" : "var(--bt-muted)" }}>{meta}</span>}
            </>
          ) : <span style={{ color: "var(--bt-muted)" }}>No next action set</span>}
        </span>
      </button>
    </li>
  );
}

export function OpportunitiesSheet({ rows, filters, shown, loading, error, today, onFilters, onOpen }: {
  rows: SheetRow[];
  shown: SheetRow[];
  filters: SheetFilters;
  loading: boolean;
  error: string | null;
  today: string;
  onFilters: (next: SheetFilters) => void;
  onOpen: (row: SheetRow) => void;
}) {
  const options = sheetOptions(rows);
  const set = (patch: Partial<SheetFilters>) => onFilters({ ...filters, ...patch });
  const filtered = filters.query.trim() !== "" || filters.side !== "all" || filters.progress !== "all" || filters.company !== "all" || filters.category !== "all";
  const sides: [SheetFilters["side"], string][] = [["all", "All"], ["buyer", SIDE_LABEL.buyer], ["seller", SIDE_LABEL.seller], ["both", SIDE_LABEL.both]];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <span className="sr-only">Search opportunities</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--bt-muted)" }} />
          <input type="search" value={filters.query} onChange={(event) => set({ query: event.target.value })}
            placeholder="Search buyers, offers, trades" className={`${field} w-full pl-9`} style={fieldStyle} />
        </label>
        <div role="group" aria-label="Starting point" className="flex max-w-full overflow-x-auto rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {sides.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={filters.side === value} onClick={() => set({ side: value })}
              className="h-8 shrink-0 rounded-md px-3 text-[13px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
              style={filters.side === value
                ? { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
                : { color: "var(--bt-text-2)" }}>
              {label}
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
        {loading && !rows.length ? "Loading…" : `${shown.length} of ${rows.length} open`}
      </p>

      <div className="overflow-hidden rounded-xl border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <div aria-hidden="true" className={`hidden gap-x-4 border-b px-4 py-2 text-[12px] md:grid ${GRID}`} style={{ borderColor: "var(--bt-divider)", color: "var(--bt-muted)" }}>
          <span>Opportunity</span><span>Company</span><span>Progress</span><span className="hidden lg:block">Latest development</span><span>Next action</span>
        </div>
        {shown.length > 0 ? (
          <ul className="divide-y" style={{ borderColor: "var(--bt-divider)" }}>
            {shown.map((row) => <SheetRowItem key={row.key} row={row} today={today} onOpen={onOpen} />)}
          </ul>
        ) : loading && !rows.length ? (
          <ul aria-hidden="true" className="divide-y" style={{ borderColor: "var(--bt-divider)" }}>
            {[0, 1, 2, 3].map((n) => (
              <li key={n} className="flex animate-pulse flex-col gap-2 px-4 py-4 motion-reduce:animate-none">
                <span className="h-3.5 w-2/5 rounded" style={{ background: "var(--bt-segment)" }} />
                <span className="h-3 w-1/4 rounded" style={{ background: "var(--bt-segment)" }} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--bt-muted)" }}>
            {error ? "The sheet could not load." : filtered ? "No opportunities match these filters." : "Nothing open right now."}
          </p>
        )}
      </div>
    </div>
  );
}
