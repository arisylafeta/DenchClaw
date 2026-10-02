"use client";

import { useState } from "react";
import {
  HOLD_STAGE,
  LIVE_STAGES,
  TRADE_GROUPS,
  dueLabel,
  heldTrades,
  holdLabel,
  stageTotal,
  tradeGroup,
  type BulkTrade,
  type TradeStage,
} from "@/lib/bulk-trades";
import { DueChip, GROUP_TONE } from "./trade-chips";

const CLOSED_STAGES: TradeStage[] = ["Done", "Lost"];

type Props = {
  trades: BulkTrade[];
  today: string;
  onOpen: (trade: BulkTrade) => void;
  onMove: (trade: BulkTrade, stage: TradeStage) => void;
};

function useDropTarget(stage: TradeStage, trades: BulkTrade[], onMove: Props["onMove"]) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        setOver(false);
        const trade = trades.find((candidate) => candidate.id === event.dataTransfer.getData("text/plain"));
        if (trade && trade.trade_stage !== stage) onMove(trade, stage);
      },
    },
  };
}

function Column({ stage, trades, today, onOpen, onMove }: Props & { stage: TradeStage }) {
  const { over, handlers } = useDropTarget(stage, trades, onMove);
  const held = stage === HOLD_STAGE;
  const cards = held
    ? [...heldTrades(trades, today).ended, ...heldTrades(trades, today).waiting]
    : trades
      .filter((trade) => trade.trade_stage === stage)
      .sort((a, b) =>
        TRADE_GROUPS.indexOf(tradeGroup(a, today)) - TRADE_GROUPS.indexOf(tradeGroup(b, today))
        || String(a.next_step_due ?? "9999").localeCompare(String(b.next_step_due ?? "9999")));

  const total = stageTotal(cards);

  return (
    <section
      aria-label={stage}
      {...handlers}
      className="flex min-h-0 min-w-[280px] flex-1 flex-col gap-2.5 overflow-y-auto rounded-none p-3"
      style={{ background: over ? "var(--bt-column-over)" : "var(--bt-column)" }}
    >
      <header className="flex items-center gap-2 px-1 pb-1 pt-0.5">
        <h2 className="text-sm font-semibold">{stage}</h2>
        <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{cards.length}</span>
        <span className="flex-1" />
        {total && <span className="bt-mono text-[13px] font-medium" style={{ color: "var(--bt-text-2)" }}>{total}</span>}
      </header>
      {cards.map((trade) => (
        <button
          key={trade.id}
          type="button"
          draggable
          onDragStart={(event) => event.dataTransfer.setData("text/plain", trade.id)}
          onClick={() => onOpen(trade)}
          className="flex shrink-0 cursor-grab flex-col gap-1.5 rounded-none border px-3.5 py-3 text-left hover:border-[var(--bt-border-strong)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bt-text)] active:cursor-grabbing"
          style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}
        >
          <div className="flex items-baseline gap-2">
            <span className="flex-1 text-sm font-semibold">{trade.title}</span>
            {!!trade.new_count && (
              <span className="shrink-0 rounded-none px-[7px] py-px text-[11px] font-semibold" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>
                {trade.new_count} new
              </span>
            )}
            {trade.value && <span className="bt-mono shrink-0 text-[13px] font-medium">{trade.value}</span>}
          </div>
          {trade.fact_line && <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{trade.fact_line}</span>}
          <div className="flex items-center gap-2 border-t pt-1.5" style={{ borderColor: "var(--bt-divider)" }}>
            <span className="flex-1 text-[13px] leading-[1.35]">{held ? trade.hold_reason ?? "On hold" : trade.next_step ?? "Set a next step"}</span>
            {held
              ? <DueChip label={holdLabel(trade, today)} tone={trade.hold_until && trade.hold_until <= today ? "red" : "grey"} />
              : <DueChip label={dueLabel(trade, today)} tone={GROUP_TONE[tradeGroup(trade, today)]} />}
          </div>
        </button>
      ))}
    </section>
  );
}

function ClosedZone({ stage, trades, onMove }: Pick<Props, "trades" | "onMove"> & { stage: TradeStage }) {
  const { over, handlers } = useDropTarget(stage, trades, onMove);
  const count = trades.filter((trade) => trade.trade_stage === stage).length;
  return (
    <div
      {...handlers}
      className="flex h-12 min-w-[160px] items-center justify-center gap-2 rounded-none border border-dashed text-[13px] font-semibold"
      style={{
        borderColor: "var(--bt-border-strong)",
        background: over ? "var(--bt-column-over)" : "transparent",
        color: "var(--bt-text-2)",
      }}
    >
      {stage}
      <span className="font-medium" style={{ color: "var(--bt-muted)" }}>{count}</span>
    </div>
  );
}

export function TradesBoard(props: Props) {
  return (
    <div className="flex h-full min-h-[480px] flex-col gap-4">
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(3,minmax(280px,1fr))_minmax(240px,0.8fr)] gap-5 overflow-x-auto">
        {LIVE_STAGES.map((stage) => <Column key={stage} stage={stage} {...props} />)}
        <Column stage={HOLD_STAGE} {...props} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs" style={{ color: "var(--bt-muted)" }}>Drop here to close</span>
        {CLOSED_STAGES.map((stage) => <ClosedZone key={stage} stage={stage} trades={props.trades} onMove={props.onMove} />)}
      </div>
    </div>
  );
}
