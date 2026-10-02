"use client";

import { dueLabel, groupTrades, touchedLabel, type BulkTrade } from "@/lib/bulk-trades";
import { DueChip, GROUP_TONE, TONE_HEADING } from "./trade-chips";
import tableStyles from "../ui/data-table.module.css";

const COLUMNS = "grid-cols-[minmax(0,1.5fr)_120px_130px_minmax(0,1.6fr)_110px_80px]";

type Props = {
  trades: BulkTrade[];
  today: string;
  onOpen: (trade: BulkTrade) => void;
};

export function TradesList({ trades, today, onOpen }: Props) {
  const groups = groupTrades(trades, today);

  if (!groups.length) {
    return <p className="px-4 py-10 text-center text-sm" style={{ color: "var(--bt-muted)" }}>No live trades.</p>;
  }

  return (
    <div className={`bulk-trades ${tableStyles.surface} flex min-w-[860px] flex-col gap-5`}>
      <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-4 border-b px-3 py-2 font-medium`}>
        <span>Trade</span><span>Stage</span><span>Value</span><span>Next step</span><span>Due</span><span>Touched</span>
      </div>
      {groups.map((group) => (
        <section key={group.name} className="flex flex-col gap-1.5" aria-label={group.name}>
          <h2
            className="flex items-center gap-2 px-1 text-[13px] font-semibold"
            style={{ color: TONE_HEADING[GROUP_TONE[group.name]] }}
          >
            {group.name}
            <span className="font-medium" style={{ color: "var(--bt-muted)" }}>{group.trades.length}</span>
          </h2>
          <div className="overflow-hidden rounded-none border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {group.trades.map((trade) => (
              <button
                key={trade.id}
                data-table-part="grid-row"
                type="button"
                onClick={() => onOpen(trade)}
                className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]`}
                style={{ borderColor: "var(--bt-divider)" }}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold">{trade.title}</span>
                    {!!trade.new_count && (
                    <span className="shrink-0 rounded-none px-[7px] py-px text-[11px] font-semibold" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>
                      {trade.new_count} new
                    </span>
                  )}
                  </div>
                  {trade.fact_line && (
                    <div className="mt-0.5 truncate text-xs" style={{ color: "var(--bt-muted)" }}>{trade.fact_line}</div>
                  )}
                </div>
                <span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{trade.trade_stage}</span>
                <span className="bt-mono truncate text-xs font-medium">{trade.value ?? ""}</span>
                <span className="text-xs leading-[1.35]">{trade.next_step ?? "Set a next step"}</span>
                <span><DueChip label={dueLabel(trade, today)} tone={GROUP_TONE[group.name]} /></span>
                <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{touchedLabel(trade, today)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
