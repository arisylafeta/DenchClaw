"use client";

import { Search } from "lucide-react";
import { filterSheet, NO_FILTERS, SHEET_SORTS, SIDE_LABEL, SORT_LABEL, WAITING_LABEL, sheetOptions, type SheetFilters, type SheetRow, type SheetSort, type SheetTone } from "@/lib/bulk-sheet";
import { shortDate } from "@/lib/bulk-trade-details";

const TONE: Record<SheetTone, { dot: string; bg: string }> = {
  new: { dot: "var(--bt-muted)", bg: "var(--bt-segment)" },
  active: { dot: "var(--bt-blue)", bg: "var(--bt-blue-bg)" },
  waiting: { dot: "var(--bt-amber)", bg: "var(--bt-amber-bg)" },
  closing: { dot: "var(--bt-green)", bg: "var(--bt-green-bg)" },
  hold: { dot: "var(--bt-purple)", bg: "var(--bt-purple-bg)" },
  warning: { dot: "var(--bt-red)", bg: "var(--bt-red-bg)" },
};

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

/** True when the filter bar narrows the rows. The driver is a page choice, and a locked side is the tab itself. */
export function isFiltered(filters: SheetFilters, sideLocked: boolean): boolean {
  return filters.query.trim() !== "" || (!sideLocked && filters.side !== "all") || filters.progress !== "all" || filters.company !== "all" || filters.category !== "all" || filters.waiting !== "all";
}

/** Stage chips, starting point and menus (and search, unless the page has its own); the Filters popover on every list tab. */
export function SheetFilterBar({ rows, filters, onFilters, hideProgress = false, hideSide = false, hideSearch = false, stages, mainStages, sort, onSort }: {
  rows: SheetRow[]; filters: SheetFilters; onFilters: (next: SheetFilters) => void; hideProgress?: boolean;
  /** Search lives elsewhere (the page header): leave it out here. */
  hideSearch?: boolean;
  /** The sheet is locked to one kind (Requests or Supply): no Buying/Selling toggle. */
  hideSide?: boolean;
  /** The Progress choices; defaults to the stages present in the rows. */
  stages?: readonly string[];
  /** The stages shown as buttons; the other `stages` go in a "More stages" menu. Defaults to all of them. */
  mainStages?: readonly string[];
  sort?: SheetSort; onSort?: (next: SheetSort) => void;
}) {
  const options = sheetOptions(rows);
  const set = (patch: Partial<SheetFilters>) => onFilters({ ...filters, ...patch });
  const filtered = isFiltered(filters, hideSide);
  const sides = ["buyer", "seller"] as const;
  // Chip counts follow every filter except the stage itself, so they add up to what the list would show.
  const countable = filterSheet(rows, { ...filters, progress: "all" });
  const stageCount = (stage: string) => countable.filter((row) => row.progress === stage).length;
  const chip = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]`;
  const chipStyle = (on: boolean) => on ? { background: "var(--bt-text)", borderColor: "var(--bt-text)", color: "var(--bt-surface)" } : { background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" };
  return (
    <div className="flex flex-col gap-2.5">
      {!hideProgress && stages && (
        <div role="group" aria-label="Stage" className="flex flex-wrap gap-1.5">
          {(["all", ...stages.filter((stage) => !mainStages || mainStages.includes(stage))] as string[]).map((stage) => {
            const on = filters.progress === stage;
            return (
              <button key={stage} type="button" aria-pressed={on} onClick={() => set({ progress: on && stage !== "all" ? "all" : stage })} className={chip} style={chipStyle(on)}>
                {stage === "all" ? "All" : stage}
                <span className="tabular-nums" style={{ color: on ? "inherit" : "var(--bt-muted)", opacity: on ? 0.75 : 1 }}>{stage === "all" ? countable.length : stageCount(stage)}</span>
              </button>
            );
          })}
          {mainStages && (() => {
            const more = stages.filter((stage) => !mainStages.includes(stage));
            if (!more.length) return null;
            const on = more.includes(filters.progress);
            return (
              <select aria-label="More stages" value={on ? filters.progress : ""} onChange={(event) => set({ progress: event.target.value || "all" })}
                className={`${chip} appearance-auto`} style={chipStyle(on)}>
                <option value="">More stages</option>
                {more.map((stage) => <option key={stage} value={stage}>{stage} ({stageCount(stage)})</option>)}
              </select>
            );
          })()}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!hideSearch && <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
          <span className="sr-only">Search opportunities</span>
          <Search size={15} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "var(--bt-muted)" }} />
          <input type="search" value={filters.query} onChange={(event) => set({ query: event.target.value })}
            placeholder="Search buyers, offers, trades" className={`${field} w-full pl-9`} style={fieldStyle} />
        </label>}
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
          <select aria-label="Sort by" value={sort ?? "urgent"} onChange={(event) => onSort(event.target.value as SheetSort)}
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
