"use client";

import { useCallback, useEffect, useState } from "react";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import {
  LIVE_STAGES,
  todayInLondon,
  type BulkTrade,
  type TradeOwner,
  type TradePatch,
  type TradeStage,
} from "@/lib/bulk-trades";
import { DemandPage } from "./demand-page";
import { TradeEditor } from "./trade-editor";
import { TradePage } from "./trade-page";
import { ProposalRow } from "./proposal-row";
import { ErrorText, request } from "./trade-ui";
import { TradesBoard } from "./trades-board";
import { TradesList } from "./trades-list";

type Mode = "list" | "board" | "demand";
const MODE_KEY = "bulk-trades:view";

function storedMode(): Mode {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    return stored === "board" || stored === "demand" ? stored : "list";
  } catch {
    return "list";
  }
}

type Props = {
  onOpenEntry?: (objectName: string, entryId: string) => void;
};

export function BulkTradesView({ onOpenEntry }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [trades, setTrades] = useState<BulkTrade[]>([]);
  const [owners, setOwners] = useState<TradeOwner[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [check, setCheck] = useState<CheckStatus>(null);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [showPossible, setShowPossible] = useState(false);
  const [openTradeId, setOpenTradeId] = useState<string | null>(null);
  const today = todayInLondon();

  useEffect(() => setMode(storedMode()), []);

  const load = useCallback(async () => {
    try {
      const data = await request<{ trades: BulkTrade[]; owners: TradeOwner[]; check?: CheckStatus; possible?: Proposal[] }>("/api/bulk-trades");
      setTrades(data.trades);
      setOwners(data.owners);
      setCheck(data.check ?? null);
      setPossible(data.possible ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load trades.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function switchMode(next: Mode) {
    setMode(next);
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  }

  const replace = useCallback((trade: BulkTrade) =>
    setTrades((current) => current.map((candidate) => (candidate.id === trade.id ? trade : candidate))), []);

  /** Creates a trade and opens its page. */
  async function create(patch: TradePatch) {
    const { trade } = await request<{ trade: BulkTrade }>("/api/bulk-trades", { method: "POST", body: JSON.stringify(patch) });
    setTrades((current) => [...current, trade]);
    setCreating(false);
    setOpenTradeId(trade.id);
  }

  async function move(trade: BulkTrade, stage: TradeStage) {
    setActionError(null);
    replace({ ...trade, trade_stage: stage });
    try {
      const { trade: saved } = await request<{ trade: BulkTrade }>(`/api/bulk-trades/${encodeURIComponent(trade.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ trade_stage: stage }),
      });
      replace(saved);
    } catch (err) {
      replace(trade);
      setActionError(`Could not move ${trade.title}: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }

  if (openTradeId) {
    return (
      <div className="bulk-trades h-full">
        <TradePage
          key={openTradeId}
          tradeId={openTradeId}
          owners={owners}
          today={today}
          onBack={() => { setOpenTradeId(null); void load(); }}
          onTradeSaved={replace}
          onOpenEvidence={onOpenEntry ? () => onOpenEntry("bulk_trade", openTradeId) : undefined}
        />
      </div>
    );
  }

  const open = (trade: BulkTrade) => setOpenTradeId(trade.id);
  const liveCount = trades.filter((trade) => (LIVE_STAGES as readonly string[]).includes(trade.trade_stage)).length;
  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => switchMode(value)}
      className="flex h-[30px] items-center rounded-none px-3 text-[13px]"
      style={mode === value
        ? { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" }
        : { color: "var(--bt-text-2)", fontWeight: 500 }}
    >
      {label}
    </button>
  );

  return (
    <div className="bulk-trades flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b px-8 py-5" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Bulk Trades</h1>
        <nav aria-label="View" className="ml-2 flex rounded-none p-[3px]" style={{ background: "var(--bt-segment)" }}>
          {tab("list", "List")}
          {tab("board", "Board")}
          {tab("demand", "Demand")}
        </nav>
        <span className="text-sm" style={{ color: "var(--bt-muted)" }}>
          {mode === "demand" ? "who wants what, matched to live trades"
            : `${liveCount} live · ${mode === "list" ? "sorted by what needs you first" : "drag to change stage"}`}
        </span>
        <div className="flex-1" />
        {check && <CheckLine check={check} />}
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-9 items-center gap-1.5 rounded-none bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
          style={{ color: "var(--bt-on-accent)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New trade
        </button>
      </header>

      <main className={`flex-1 overflow-auto px-8 pb-8 ${mode === "list" ? "pt-5" : "pt-6"}`}>
        <ErrorText error={loadError} />
        <ErrorText error={actionError} />
        {mode !== "demand" && !!possible.length && (
          <section aria-label="Possible new trades" className="mb-5 overflow-hidden rounded-none border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            <button type="button" aria-expanded={showPossible} onClick={() => setShowPossible((open) => !open)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-semibold">
              <span className="rounded-none px-[7px] py-px text-[11px]" style={{ background: "var(--bt-badge)", color: "var(--bt-on-badge)" }}>{possible.length}</span>
              Possible new {possible.length === 1 ? "trade" : "trades"} from your inbox
              <span className="flex-1" />
              <span className="text-[13px] font-medium" style={{ color: "var(--bt-muted)" }}>{showPossible ? "Hide" : "Review"}</span>
            </button>
            {showPossible && (
              <div className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
                {possible.map((proposal) => (
                  <div key={proposal.id} className="border-b last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
                    <div className="px-5 pt-3 text-sm font-semibold">{String(proposal.proposed.title)}</div>
                    <ProposalRow
                      proposal={proposal}
                      onDecided={(decided, action, lotId) => {
                        setPossible((current) => current.filter((candidate) => candidate.id !== decided.id));
                        if (action === "accept" && lotId) { void load(); setOpenTradeId(lotId); }
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {mode === "demand"
          ? <DemandPage today={today} onOpenTrade={setOpenTradeId} />
          : mode === "list"
            ? <TradesList trades={trades} today={today} onOpen={open} />
            : <TradesBoard trades={trades} today={today} onOpen={open} onMove={move} />}
      </main>

      {creating && (
        <TradeEditor trade={null} owners={owners} today={today} onClose={() => setCreating(false)} onSave={create} />
      )}
    </div>
  );
}

/** "Gmail and Granola checked 13:00 · next 15:30", with a red dot when the last check failed. */
function CheckLine({ check }: { check: NonNullable<CheckStatus> }) {
  const failed = check.status === "failed";
  return (
    <span className="flex items-center gap-2 text-[13px]" style={{ color: failed ? "var(--bt-red)" : "var(--bt-text-2)" }} title={check.error ?? undefined}>
      <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ background: failed ? "var(--bt-red)" : "var(--bt-ok)" }} />
      {failed ? `Gmail and Granola check failed ${ukTime(check.last_run_at)}` : `Gmail and Granola checked ${ukTime(check.last_run_at)}`}
      {" · "}next {nextCheckTime()}
    </span>
  );
}
