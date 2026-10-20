"use client";

import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import type { BulkTradesRoute } from "@/lib/bulk-trades-url";
import { CLOSED_REASON_LABEL, HISTORY_CATEGORIES } from "@/lib/bulk-demand";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import type { BestMatchLine } from "@/lib/demand-supply-types";
import { Card, ErrorText, peekShared, request, sharedGet } from "./trade-ui";
import styles from "./bulk-detail.module.css";
import { DemandDialog } from "./demand-editor";
import { DemandPanel } from "./demand-panel";
import { FitBadge } from "./demand-supply-tab";

const MISSING_ORDER = [
  "no supply match",
  "no price",
  "no quantity",
  "no timeline",
  "question not sent",
];
/** Next column: the best inventory match when there is one, else the first gap that blocks the deal. */
function NextChip({ demand, best }: { demand: Demand; best?: BestMatchLine }) {
  // Qualifying rows: the open question is the next thing to do, not the match.
  if (demand.status === "qualifying") {
    return (
      <span className="min-w-0 text-[12px]">
        <span className="break-words">{demand.qualify_question ?? "Question not written yet"}</span>
        <span className="block" style={{ color: demand.qualify_asked_on ? "var(--bt-muted)" : "var(--color-warning)" }}>
          {demand.qualify_asked_on ? `Asked ${shortDate(demand.qualify_asked_on)}` : "Not asked yet"}
        </span>
      </span>
    );
  }
  if (best?.verdict) {
    return (
      <span className="min-w-0 text-[12px]">
        {best.verdict && <span className="mr-1.5 inline-block align-middle"><FitBadge verdict={best.verdict} /></span>}
        <span className="break-words">{best.text}</span>
        {best.shortlisted > 0 && <span style={{ color: "var(--bt-muted)" }}> · {best.shortlisted} shortlisted</span>}
      </span>
    );
  }
  const count = demand.inventory_matches?.length ?? 0;
  const missing = MISSING_ORDER.find((gap) => demand.missing?.includes(gap));
  if (!count && !missing) return best ? <span className="text-[12px]" style={{ color: "var(--color-warning)" }}>{best.text}</span> : null;
  return (
    <span
      className={`${styles.chip} justify-self-start`}
      style={{ color: count ? "var(--bt-green)" : "var(--color-warning)" }}
    >
      {count
        ? `${count} supply ${count === 1 ? "match" : "matches"}`
        : missing![0].toUpperCase() + missing!.slice(1)}
    </span>
  );
}
export const rowFocus =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--bt-accent)]";
export function ScorePill({ score }: { score: number | null }) {
  const color =
    score == null
      ? "var(--bt-muted)"
      : score >= 80
        ? "var(--bt-green)"
        : score >= 60
          ? "var(--color-warning)"
          : "var(--bt-muted)";
  return (
    <span
      className="inline-flex min-w-10 self-start justify-center rounded-full border px-2 py-1 text-xs font-semibold tabular-nums"
      style={{ color, borderColor: color }}
      aria-label={score == null ? "Not scored" : `Score ${score}`}
    >
      {score ?? "?"}
    </span>
  );
}
export function SheetTabs({
  tabs,
  value,
  onChange,
  labels,
  icons,
  centered,
}: {
  tabs: string[];
  value: string;
  onChange: (tab: string) => void;
  labels?: Record<string, string>;
  icons?: Record<string, LucideIcon>;
  centered?: boolean;
}) {
  return (
    <nav
      aria-label="Detail sections"
      className={`flex gap-5 border-b${centered ? " justify-center" : ""}`}
      style={{ borderColor: "var(--bt-border)" }}
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-pressed={value === tab}
          onClick={() => onChange(tab)}
          className={`${rowFocus} inline-flex items-center gap-1.5 border-b-2 py-3 text-[13px] font-medium`}
          style={{
            borderColor: value === tab ? "var(--bt-accent)" : "transparent",
            color: value === tab ? "var(--bt-text)" : "var(--bt-muted)",
          }}
        >
          {icons?.[tab] && (() => { const Icon = icons[tab]; return <Icon size={14} aria-hidden="true" />; })()}
          {labels?.[tab] ?? tab}
        </button>
      ))}
    </nav>
  );
}
export function ChatHint({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <footer
      className="mt-auto border-t pt-4 text-[13px]"
      style={{ borderColor: "var(--bt-border)", color: "var(--bt-muted)" }}
    >
      Disagree? Tell the agent in chat with ID <code>{id}</code>{" "}
      <button
        type="button"
        className={`${rowFocus} ml-2 underline`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(id);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy ID"}
      </button>
    </footer>
  );
}
const DEMAND_URL = "/api/bulk-trades/demand";
const MATCHES_URL = "/api/bulk-trades/demand/matches";

export function DemandPage({
  today,
  onOpenTrade,
  onOpenSupply,
  initialDemandId,
  route,
  onRouteChange,
}: {
  today: string;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  initialDemandId?: string | null;
  /** The page's URL state. Without it the page keeps its state locally. */
  route?: Pick<BulkTradesRoute, "demand" | "status" | "query" | "category">;
  onRouteChange?: (patch: Partial<BulkTradesRoute>, mode: "push" | "replace") => void;
}) {
  initialDemandId = route ? route.demand : initialDemandId;
  // Rows already loaded by another tab show at once; the fetch below refreshes them.
  const [demand, setDemand] = useState<Demand[]>(() => peekShared<{ demand: Demand[] }>(DEMAND_URL)?.demand ?? []);
  const [filter, setFilterState] = useState(route?.status ?? "open");
  const [query, setQueryState] = useState(route?.query ?? "");
  const [category, setCategoryState] = useState(route?.category ?? "all");
  const [selectedId, setSelectedState] = useState(initialDemandId ?? null);
  // Defaults stay out of the URL so shared links are short.
  const setFilter = (value: string) => { setFilterState(value); onRouteChange?.({ status: value === "open" ? null : value, category: null }, "replace"); setCategoryState("all"); };
  const setQuery = (value: string) => { setQueryState(value); onRouteChange?.({ query: value || null }, "replace"); };
  const setCategory = (value: string) => { setCategoryState(value); onRouteChange?.({ category: value === "all" ? null : value }, "replace"); };
  const setSelectedId = (id: string | null) => { setSelectedState(id); onRouteChange?.({ demand: id }, "push"); };
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !peekShared(DEMAND_URL));
  const [best, setBest] = useState<Record<string, BestMatchLine>>(() => peekShared<{ matches?: Record<string, BestMatchLine> }>(MATCHES_URL)?.matches ?? {});
  const latest = useRef({ demand: 0, best: 0 });
  // Match lines are slow and optional: they never hold up the rows.
  const loadBest = useCallback(async () => {
    const seq = ++latest.current.best;
    try {
      const data = await sharedGet<{ matches?: Record<string, BestMatchLine> }>(MATCHES_URL);
      if (seq === latest.current.best) setBest(data.matches ?? {});
    } catch {
      if (seq === latest.current.best) setBest({});
    }
  }, []);
  useEffect(() => {
    void loadBest();
  }, [loadBest]);
  const load = useCallback(async () => {
    const seq = ++latest.current.demand;
    try {
      const data = await sharedGet<{ demand: Demand[] }>(DEMAND_URL);
      if (seq === latest.current.demand) setDemand(data.demand);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load demand.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSelectedState(initialDemandId ?? null);
  }, [initialDemandId]);
  // Back/forward and pasted links change the URL under us.
  useEffect(() => {
    if (!route) return;
    setFilterState(route.status ?? "open");
    setQueryState(route.query ?? "");
    setCategoryState(route.category ?? "all");
  }, [route?.status, route?.query, route?.category]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(
    () =>
      demand.filter(
        (row) =>
          row.status === filter &&
          (filter !== "closed" || (category === "all"
            ? row.closed_reason !== "research_profile"
            : (row.closed_reason === "moved_to_lot" ? "offer_reply" : row.closed_reason) === category)) &&
          `${row.buyer} ${row.wants} ${row.product_family ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [demand, filter, query, category],
  );
  const selected = demand.find((row) => row.id === selectedId);
  const columns =
    "grid-cols-[52px_minmax(250px,2fr)_100px_90px_minmax(180px,1fr)]";
  if (selected) {
    return (
      <DemandPanel
        key={selected.id}
        demand={selected}
        today={today}
        onChanged={load}
        onClose={() => setSelectedId(null)}
        onOpenTrade={onOpenTrade}
        onOpenSupply={onOpenSupply}
        onOpenDemand={setSelectedId}
      />
    );
  }
  return (
    <div className="space-y-5">
      <ErrorText error={error} />
      <div className="flex flex-wrap gap-3">
        <div role="group" aria-label="Filter" className="flex gap-1">
          {[
            ["open", "Demand"],
            ["qualifying", "Qualifying"],
            ["closed", "History"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              className={`${rowFocus} px-3 py-2 text-[13px]`}
              style={{
                background:
                  filter === value ? "var(--bt-row-hover)" : undefined,
              }}
              onClick={() => setFilter(value)}
            >
              {label} {demand.filter((row) => row.status === value).length}
            </button>
          ))}
        </div>
        <input
          type="search"
          aria-label="Search demand"
          placeholder="Search buyers or asks"
          className="border px-3 text-[13px]"
          style={{
            background: "var(--bt-surface)",
            borderColor: "var(--bt-border)",
          }}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className={`${rowFocus} ml-auto border px-3 py-2 text-[13px]`}
          style={{ borderColor: "var(--bt-border)" }}
          onClick={() => setAdding(true)}
        >
          Add demand
        </button>
      </div>
      {filter === "closed" && (
        <div role="group" aria-label="History categories" className="flex flex-wrap gap-2">
          {["all", ...HISTORY_CATEGORIES].map((reason) => (
            <button key={reason} type="button" aria-pressed={category === reason}
              className={`${rowFocus} ${styles.chip} px-3 py-2`}
              style={{ background: category === reason ? "var(--bt-row-hover)" : undefined }}
              onClick={() => setCategory(reason)}>
              {reason === "all" ? "All" : CLOSED_REASON_LABEL[reason as keyof typeof CLOSED_REASON_LABEL]}{" "}
              {demand.filter((row) => row.status === "closed" && (reason === "all" ||
                (row.closed_reason === "moved_to_lot" ? "offer_reply" : row.closed_reason) === reason)).length}
            </button>
          ))}
        </div>
      )}
      {filter === "closed" ? (
        <Card label="History">
          <div className="px-4 py-2 text-[11px] uppercase tracking-wider" style={{ color: "var(--bt-muted)" }}>Buyer / ask</div>
          {shown.map((row) => (
            <button key={row.id} type="button" onClick={() => setSelectedId(row.id)}
              className={`${rowFocus} flex w-full items-center gap-3 border-t px-4 py-3 text-left hover:bg-[var(--bt-row-hover)]`}
              style={{ borderColor: "var(--bt-divider)" }}>
              <span className="min-w-0 flex-1 truncate text-[13px]"><strong>{row.buyer}</strong>{" — "}{row.wants}</span>
              <span className="hidden text-[12px] sm:block" style={{ color: "var(--bt-muted)" }}>
                {row.asked_on ? shortDate(row.asked_on) : ""} {row.source_label ?? row.source_kind}
              </span>
              <span className={`${styles.chip} shrink-0`}>{row.closed_reason ? CLOSED_REASON_LABEL[row.closed_reason] : "Other"}</span>
            </button>
          ))}
          {!shown.length && <p className="p-4 text-[13px]" style={{ color: "var(--bt-muted)" }}>{loading ? "Loading history…" : "No history here."}</p>}
        </Card>
      ) : (
      <Card label="Demand" className="overflow-x-auto">
        <div className="min-w-[850px]">
          <div
            className={`grid ${columns} gap-4 border-b px-4 py-2 text-[11px] uppercase tracking-wider`}
            style={{
              color: "var(--bt-muted)",
              borderColor: "var(--bt-border)",
            }}
          >
            <span>Score</span>
            <span>Buyer / ask</span>
            <span className="text-right">Fee</span>
            <span>Asked</span>
            <span>{filter === "qualifying" ? "Open question" : "Best match"}</span>
          </div>
          {shown.map((row) => (
            <button
              type="button"
              key={row.id}
              className={`${rowFocus} grid w-full ${columns} items-center gap-4 border-b px-4 py-3 text-left hover:bg-[var(--bt-row-hover)]`}
              style={{ borderColor: "var(--bt-divider)" }}
              onClick={() => setSelectedId(row.id)}
            >
              <ScorePill score={row.score} />
              <div className="min-w-0">
                <div className="text-[14px] font-semibold">
                  {row.buyer}
                  {row.priority && (
                    <span
                      className="ml-2 text-[11px]"
                      style={{ color: "var(--bt-green)" }}
                    >
                      Priority
                    </span>
                  )}
                </div>
                <p
                  className="mt-1 text-[13px]"
                  style={{ color: "var(--bt-muted)" }}
                >
                  {row.wants}
                </p>
                {row.product_family && (
                  <span className={`${styles.chip} mt-1`}>
                    {row.product_family}
                  </span>
                )}
              </div>
              <span className="text-right text-[13px] font-bold tabular-nums">
                {row.fee_eur == null ? "" : formatFee(row.fee_eur)}
              </span>
              <span
                className="text-[13px]"
                style={{ color: "var(--bt-muted)" }}
              >
                {row.asked_on ? shortDate(row.asked_on) : ""}
              </span>
              <NextChip demand={row} best={best[row.id]} />
            </button>
          ))}
          {!shown.length && (
            <p
              className="py-8 text-center text-[13px]"
              style={{ color: "var(--bt-muted)" }}
            >
              {loading ? "Loading demand…" : "No demand here."}
            </p>
          )}
        </div>
      </Card>
      )}
      {adding && (
        <DemandDialog
          demand={null}
          onClose={() => setAdding(false)}
          onSaved={(saved) => {
            setAdding(false);
            setSelectedId(saved.id);
            void load();
          }}
        />
      )}
    </div>
  );
}
