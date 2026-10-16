"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Demand } from "@/lib/bulk-demand";
import { priceLabel, volumeLabel, specLines } from "@/lib/bulk-demand";
import { formatFee } from "@/lib/bulk-demand-score";
import { shortDate } from "@/lib/bulk-trade-details";
import { buildEntryLink } from "@/lib/workspace-links";
import { Card, DetailSheet, ErrorText, request } from "./trade-ui";
import styles from "./bulk-detail.module.css";
import { DemandActions } from "./demand-actions";
import { DemandDialog } from "./demand-editor";
import { CompanyContext } from "./company-context";

const MISSING_ORDER = [
  "no supply match",
  "no price",
  "no quantity",
  "no timeline",
  "question not sent",
];
function NextChip({ demand }: { demand: Demand }) {
  const count = demand.inventory_matches?.length ?? 0;
  const missing = MISSING_ORDER.find((gap) => demand.missing?.includes(gap));
  if (!count && !missing) return null;
  return (
    <span
      className={`${styles.chip} justify-self-start`}
      style={{ color: count ? "var(--bt-green)" : "var(--color-warning)" }}
    >
      {count
        ? `${count} supply matches`
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
}: {
  tabs: string[];
  value: string;
  onChange: (tab: string) => void;
}) {
  return (
    <nav
      aria-label="Detail sections"
      className="flex gap-5 border-b"
      style={{ borderColor: "var(--bt-border)" }}
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          aria-pressed={value === tab}
          onClick={() => onChange(tab)}
          className={`${rowFocus} border-b-2 py-3 text-[13px] font-medium`}
          style={{
            borderColor: value === tab ? "var(--bt-accent)" : "transparent",
            color: value === tab ? "var(--bt-text)" : "var(--bt-muted)",
          }}
        >
          {tab}
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
export function DemandPage({
  today,
  onOpenTrade,
  onOpenSupply,
  initialDemandId,
}: {
  today: string;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
  initialDemandId?: string | null;
}) {
  const [demand, setDemand] = useState<Demand[]>([]);
  const [filter, setFilter] = useState("open");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialDemandId ?? null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const data = await request<{ demand: Demand[] }>(
        "/api/bulk-trades/demand",
      );
      setDemand(data.demand);
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
    setSelectedId(initialDemandId ?? null);
  }, [initialDemandId]);
  const shown = useMemo(
    () =>
      demand.filter(
        (row) =>
          row.status === filter &&
          `${row.buyer} ${row.wants} ${row.product_family ?? ""}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [demand, filter, query],
  );
  const selected = demand.find((row) => row.id === selectedId);
  const columns =
    "grid-cols-[52px_minmax(250px,2fr)_100px_90px_minmax(180px,1fr)]";
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
            <span>Next</span>
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
              <NextChip demand={row} />
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
      {selected && (
        <DemandPanel
          key={selected.id}
          demand={selected}
          today={today}
          onChanged={load}
          onClose={() => setSelectedId(null)}
          onOpenTrade={onOpenTrade}
          onOpenSupply={onOpenSupply}
        />
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
function DemandPanel({
  demand,
  today,
  onChanged,
  onClose,
  onOpenTrade,
  onOpenSupply,
}: {
  demand: Demand;
  today: string;
  onChanged: () => void;
  onClose: () => void;
  onOpenTrade: (id: string) => void;
  onOpenSupply?: (id: string) => void;
}) {
  const [tab, setTab] = useState("Overview");
  const [editing, setEditing] = useState(false);
  return (
    <DetailSheet title="Demand detail" onClose={onClose}>
      <header className="flex gap-3 pr-6">
        <ScorePill score={demand.score} />
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[20px] font-semibold">
              {demand.company_id ? (
                <a
                  href={buildEntryLink("company", demand.company_id)}
                  className={rowFocus}
                >
                  {demand.buyer}
                </a>
              ) : (
                demand.buyer
              )}
            </h2>
            <span className={styles.status}>{demand.status}</span>
          </div>
          <div className="mt-2 flex gap-2">
            {demand.product_family && (
              <span className={styles.chip}>{demand.product_family}</span>
            )}
          </div>
        </div>
      </header>
      <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>
        {demand.wants}
      </p>
      <SheetTabs
        tabs={["Overview", "Suitable supply", "Activity"]}
        value={tab}
        onChange={setTab}
      />
      {tab === "Overview" && (
        <>
          {!!demand.missing?.length && (
            <section
              className="border p-4"
              style={{
                borderColor: "var(--bt-amber)",
                color: "var(--bt-amber)",
              }}
            >
              <h3 className="text-[14px] font-semibold">
                Missing to move this
              </h3>
              <ul className="mt-2 space-y-1 text-[13px]">
                {demand.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {demand.qualify_question && (
                <p className="mt-3 text-[13px]">{demand.qualify_question}</p>
              )}
            </section>
          )}
          <dl className={styles.facts}>
            {[
              ["Quantity", volumeLabel(demand) ?? demand.quantity],
              ["Price", priceLabel(demand)],
              [
                "Fee",
                demand.fee_eur == null ? null : formatFee(demand.fee_eur),
              ],
              [
                "Timeline",
                demand.needed_by ? shortDate(demand.needed_by) : null,
              ],
              ["Location", demand.location],
              ["Asked", demand.asked_on ? shortDate(demand.asked_on) : null],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? ""}</dd>
              </div>
            ))}
          </dl>
          {demand.note && (
            <p className="whitespace-pre-wrap text-[13px]">{demand.note}</p>
          )}
          {specLines(demand.spec).map((line) => (
            <p className="text-[13px]" key={line}>
              {line}
            </p>
          ))}
          {demand.source_quote && (
            <blockquote
              className="border-l-2 pl-3 text-[13px]"
              style={{
                color: "var(--bt-muted)",
                borderColor: "var(--bt-border)",
              }}
            >
              {demand.source_quote}
            </blockquote>
          )}
        </>
      )}
      {tab === "Overview" && <CompanyContext notes={demand.context_notes} />}
      {tab === "Suitable supply" && (
        <>
          <section>
            <h3
              className="text-[11px] uppercase tracking-wider"
              style={{ color: "var(--bt-muted)" }}
            >
              In our inventory
            </h3>
            {(demand.inventory_matches ?? []).map((fit) => (
              <a
                key={fit.id}
                href={fit.href}
                className={`${rowFocus} flex w-full items-start gap-3 border-b py-4 text-left`}
                style={{ borderColor: "var(--bt-divider)" }}
                onClick={(event) => {
                  if (fit.kind === "trade") {
                    event.preventDefault();
                    onOpenTrade(fit.id.replace(/^trade:/, ""));
                  }
                  if (fit.kind === "supply" && onOpenSupply) {
                    event.preventDefault();
                    onOpenSupply(fit.id.replace(/^supply:/, ""));
                  }
                }}
              >
                <div className="flex-1">
                  <p className="text-[14px] font-semibold">{fit.title}</p>
                  <p
                    className="mt-1 text-[13px]"
                    style={{ color: "var(--bt-muted)" }}
                  >
                    {fit.reason}
                  </p>
                </div>
                <span
                  className={styles.chip}
                  style={{
                    color:
                      fit.strength === "strong"
                        ? "var(--bt-green)"
                        : "var(--bt-amber)",
                  }}
                >
                  {fit.strength === "strong" ? "Strong fit" : "Verify"}
                </span>
              </a>
            ))}
            {demand.has_stock && (
              <p
                className="border-b py-4 text-[13px]"
                style={{ borderColor: "var(--bt-divider)" }}
              >
                Stock available in this product family{" "}
                <span
                  className={styles.chip}
                  style={{ color: "var(--bt-amber)" }}
                >
                  Verify
                </span>
                <a href="/?path=stock" className={`${rowFocus} ml-2 underline`}>
                  View stock summaries
                </a>
              </p>
            )}
            {!demand.inventory_matches?.length && !demand.has_stock && (
              <p
                className="py-4 text-[13px]"
                style={{ color: "var(--bt-muted)" }}
              >
                No inventory matches yet.
              </p>
            )}
          </section>
          <section>
            <h3
              className="text-[11px] uppercase tracking-wider"
              style={{ color: "var(--bt-muted)" }}
            >
              In the market
            </h3>
            <p
              className="mt-3 text-[13px]"
              style={{ color: "var(--bt-muted)" }}
            >
              No market candidates yet
            </p>
          </section>
        </>
      )}
      <DemandActions
        section={tab}
        demand={demand}
        today={today}
        onChanged={onChanged}
        onClose={onClose}
        onEdit={() => setEditing(true)}
        onOpenTrade={onOpenTrade}
        onOpenSupply={onOpenSupply}
      />
      {editing && (
        <DemandDialog
          demand={demand}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
      <ChatHint id={demand.id} />
    </DetailSheet>
  );
}
