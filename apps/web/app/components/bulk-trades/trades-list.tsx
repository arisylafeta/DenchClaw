"use client";

import { dueLabel, groupTrades, touchedLabel, type BulkTrade } from "@/lib/bulk-trades";
import { DueChip, GROUP_TONE, TONE_HEADING } from "./trade-chips";

const COLUMNS = "grid-cols-[minmax(0,1.5fr)_120px_130px_minmax(0,1.6fr)_110px_80px]";

type Props = {
  trades: BulkTrade[];
  today: string;
  onOpen: (trade: BulkTrade) => void;
};

export function TradesList({ trades, today, onOpen }: Props) {
  const groups = groupTrades(trades, today);

  if (!groups.length) {
    return <p className="px-4 py-10 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>No live trades.</p>;
  }

  return (
    <div className="flex min-w-[860px] flex-col gap-5">
      <div className={`grid ${COLUMNS} gap-4 px-4 text-xs font-semibold`} style={{ color: "var(--color-text-muted)" }}>
        <span>Trade</span><span>Stage</span><span>Value</span><span>Next step</span><span>Due</span><span>Touched</span>
      </div>
      {groups.map((group) => (
        <section key={group.name} className="flex flex-col gap-1.5" aria-label={group.name}>
          <h2
            className="flex items-center gap-2 px-1 text-[13px] font-semibold"
            style={{ color: TONE_HEADING[GROUP_TONE[group.name]] }}
          >
            {group.name}
            <span className="font-medium" style={{ color: "var(--color-text-muted)" }}>{group.trades.length}</span>
          </h2>
          <div className="overflow-hidden rounded-xl border" style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}>
            {group.trades.map((trade) => (
              <button
                key={trade.id}
                type="button"
                onClick={() => onOpen(trade)}
                className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-4 py-3 text-left last:border-b-0 hover:bg-[var(--color-surface-hover)]`}
                style={{ borderColor: "var(--color-border)" }}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold" style={{ color: "var(--color-text)" }}>{trade.title}</div>
                  {trade.fact_line && (
                    <div className="mt-0.5 truncate text-[13px]" style={{ color: "var(--color-text-muted)" }}>{trade.fact_line}</div>
                  )}
                </div>
                <span className="text-[13px]" style={{ color: "var(--color-text-secondary)" }}>{trade.trade_stage}</span>
                <span className="truncate font-mono text-sm font-medium" style={{ color: "var(--color-text)" }}>{trade.value ?? ""}</span>
                <span className="text-sm leading-snug" style={{ color: trade.next_step ? "var(--color-text)" : "var(--color-text-muted)" }}>
                  {trade.next_step ?? "Set a next step"}
                </span>
                <span><DueChip label={dueLabel(trade, today)} tone={GROUP_TONE[group.name]} /></span>
                <span className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>{touchedLabel(trade, today)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
