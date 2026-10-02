"use client";

import { useState } from "react";
import { dueLabel, groupTrades, heldTrades, holdLabel, touchedLabel, type BulkTrade } from "@/lib/bulk-trades";
import { DueChip, GROUP_TONE, TONE_HEADING } from "./trade-chips";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";

const COLUMNS = "grid-cols-[minmax(0,1.5fr)_120px_130px_minmax(0,1.6fr)_110px_80px]";

type Props = {
  trades: BulkTrade[];
  today: string;
  onOpen: (trade: BulkTrade) => void;
};

type RowProps = {
  trade: BulkTrade;
  today: string;
  onOpen: (trade: BulkTrade) => void;
  step: string;
  due: { label: string; tone: (typeof GROUP_TONE)[keyof typeof GROUP_TONE] };
};

function TradeRow({ trade, today, onOpen, step, due }: RowProps) {
  return (
    <div
      data-table-part="grid-row"
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen(trade);
        }
      }}
      onClick={() => onOpen(trade)}
      className={`grid w-full ${COLUMNS} items-center gap-4 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--bt-text)]`}
      style={{ borderColor: "var(--bt-divider)" }}
    >
      <TableCellContent>
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
      </TableCellContent>
      <TableCellContent><span className="text-xs" style={{ color: "var(--bt-text-2)" }}>{trade.trade_stage}</span></TableCellContent>
      <TableCellContent><span className="bt-mono truncate text-xs font-medium">{trade.value ?? ""}</span></TableCellContent>
      <TableCellContent><span className="text-xs leading-[1.35]">{step}</span></TableCellContent>
      <TableCellContent><span><DueChip label={due.label} tone={due.tone} /></span></TableCellContent>
      <TableCellContent><span className="text-xs" style={{ color: "var(--bt-muted)" }}>{touchedLabel(trade, today)}</span></TableCellContent>
    </div>
  );
}

function Group({ name, count, tone, children, folded, onToggle }: {
  name: string;
  count: number;
  tone: string;
  children: React.ReactNode;
  folded?: boolean;
  onToggle?: () => void;
}) {
  const heading = (
    <>
      {name}
      <span className="font-medium" style={{ color: "var(--bt-muted)" }}>{count}</span>
    </>
  );
  return (
    <section className="flex flex-col gap-1.5" aria-label={name}>
      {onToggle ? (
        <h2 className="px-1 text-[13px] font-semibold" style={{ color: tone }}>
          <button type="button" aria-expanded={!folded} onClick={onToggle} className="flex items-center gap-2 hover:underline">
            {heading}
            <span className="font-medium" style={{ color: "var(--bt-muted)" }}>{folded ? "Show" : "Hide"}</span>
          </button>
        </h2>
      ) : (
        <h2 className="flex items-center gap-2 px-1 text-[13px] font-semibold" style={{ color: tone }}>{heading}</h2>
      )}
      {!folded && (
        <div className="overflow-hidden rounded-none border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * Live trades grouped by what needs doing, then on-hold trades: those whose hold has ended at the top,
 * the rest folded at the bottom with their resume date and reason.
 */
export function TradesList({ trades, today, onOpen }: Props) {
  const [showHeld, setShowHeld] = useState(false);
  const groups = groupTrades(trades, today);
  const held = heldTrades(trades, today);
  const holdRow = (trade: BulkTrade, tone: RowProps["due"]["tone"]) => (
    <TradeRow key={trade.id} trade={trade} today={today} onOpen={onOpen}
      step={trade.hold_reason ?? "On hold"} due={{ label: holdLabel(trade, today), tone }} />
  );

  if (!groups.length && !held.ended.length && !held.waiting.length) {
    return <p className="px-4 py-10 text-center text-sm" style={{ color: "var(--bt-muted)" }}>No live trades.</p>;
  }

  return (
    <div className={`bulk-trades ${tableStyles.surface} flex min-w-[860px] flex-col gap-5`}>
      <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-4 border-b px-3 py-2 font-medium`}>
        <span>Trade</span><span>Stage</span><span>Value</span><span>Next step</span><span>Due</span><span>Touched</span>
      </div>
      {!!held.ended.length && (
        <Group name="Hold ended" count={held.ended.length} tone={TONE_HEADING.red}>
          {held.ended.map((trade) => holdRow(trade, "red"))}
        </Group>
      )}
      {groups.map((group) => (
        <Group key={group.name} name={group.name} count={group.trades.length} tone={TONE_HEADING[GROUP_TONE[group.name]]}>
          {group.trades.map((trade) => (
            <TradeRow key={trade.id} trade={trade} today={today} onOpen={onOpen}
              step={trade.next_step ?? "Set a next step"} due={{ label: dueLabel(trade, today), tone: GROUP_TONE[group.name] }} />
          ))}
        </Group>
      ))}
      {!!held.waiting.length && (
        <Group name="On hold" count={held.waiting.length} tone="var(--bt-muted)" folded={!showHeld} onToggle={() => setShowHeld(!showHeld)}>
          {held.waiting.map((trade) => holdRow(trade, "grey"))}
        </Group>
      )}
    </div>
  );
}
