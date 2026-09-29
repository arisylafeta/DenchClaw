"use client";

import { useState } from "react";
import {
  LIVE_STAGES,
  TRADE_GROUPS,
  dueLabel,
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
  const cards = trades
    .filter((trade) => trade.trade_stage === stage)
    .sort((a, b) =>
      TRADE_GROUPS.indexOf(tradeGroup(a, today)) - TRADE_GROUPS.indexOf(tradeGroup(b, today))
      || String(a.next_step_due ?? "9999").localeCompare(String(b.next_step_due ?? "9999")));

  return (
    <section
      aria-label={stage}
      {...handlers}
      className="flex min-w-[280px] flex-1 flex-col gap-2 rounded-xl p-2"
      style={{ background: over ? "var(--color-surface-hover)" : "transparent" }}
    >
      <h2 className="flex items-center gap-2 px-1 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
        {stage}
        <span className="font-medium" style={{ color: "var(--color-text-muted)" }}>{cards.length}</span>
      </h2>
      {cards.map((trade) => (
        <button
          key={trade.id}
          type="button"
          draggable
          onDragStart={(event) => event.dataTransfer.setData("text/plain", trade.id)}
          onClick={() => onOpen(trade)}
          className="flex cursor-grab flex-col gap-1.5 rounded-xl border p-3 text-left active:cursor-grabbing"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>{trade.title}</span>
            {trade.value && (
              <span className="shrink-0 font-mono text-[13px] font-medium" style={{ color: "var(--color-text)" }}>{trade.value}</span>
            )}
          </div>
          {trade.fact_line && <span className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>{trade.fact_line}</span>}
          <div className="flex items-end justify-between gap-2">
            <span className="text-[13px] leading-snug" style={{ color: "var(--color-text)" }}>{trade.next_step ?? "Set a next step"}</span>
            <DueChip label={dueLabel(trade, today)} tone={GROUP_TONE[tradeGroup(trade, today)]} />
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
      className="flex h-16 min-w-[160px] items-center justify-center gap-2 rounded-xl border border-dashed text-[13px] font-semibold"
      style={{
        borderColor: "var(--color-border-strong)",
        background: over ? "var(--color-surface-hover)" : "transparent",
        color: "var(--color-text-secondary)",
      }}
    >
      {stage}
      <span className="font-medium" style={{ color: "var(--color-text-muted)" }}>{count}</span>
    </div>
  );
}

export function TradesBoard(props: Props) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {LIVE_STAGES.map((stage) => <Column key={stage} stage={stage} {...props} />)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Drop here to close</span>
        {CLOSED_STAGES.map((stage) => <ClosedZone key={stage} stage={stage} trades={props.trades} onMove={props.onMove} />)}
      </div>
    </div>
  );
}
