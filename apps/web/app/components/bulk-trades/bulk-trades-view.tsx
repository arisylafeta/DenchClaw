"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LIVE_STAGES,
  todayInLondon,
  type BulkTrade,
  type TradeOwner,
  type TradePatch,
  type TradeStage,
} from "@/lib/bulk-trades";
import { TradeEditor } from "./trade-editor";
import { TradesBoard } from "./trades-board";
import { TradesList } from "./trades-list";

type Mode = "list" | "board";
const MODE_KEY = "bulk-trades:view";

function storedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "board" ? "board" : "list";
  } catch {
    return "list";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
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
  const [editing, setEditing] = useState<BulkTrade | "new" | null>(null);
  const today = todayInLondon();

  useEffect(() => setMode(storedMode()), []);

  const load = useCallback(async () => {
    try {
      const data = await request<{ trades: BulkTrade[]; owners: TradeOwner[] }>("/api/bulk-trades");
      setTrades(data.trades);
      setOwners(data.owners);
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

  const replace = (trade: BulkTrade) =>
    setTrades((current) => current.map((candidate) => (candidate.id === trade.id ? trade : candidate)));

  async function save(patch: TradePatch) {
    if (editing === "new") {
      const { trade } = await request<{ trade: BulkTrade }>("/api/bulk-trades", { method: "POST", body: JSON.stringify(patch) });
      setTrades((current) => [...current, trade]);
    } else if (editing) {
      const { trade } = await request<{ trade: BulkTrade }>(`/api/bulk-trades/${encodeURIComponent(editing.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      replace(trade);
    }
    setEditing(null);
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

  const liveCount = trades.filter((trade) => (LIVE_STAGES as readonly string[]).includes(trade.trade_stage)).length;
  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => switchMode(value)}
      className="flex h-[30px] items-center rounded-[7px] px-3 text-[13px]"
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
        <nav aria-label="View" className="ml-2 flex rounded-[9px] p-[3px]" style={{ background: "var(--bt-segment)" }}>
          {tab("list", "List")}
          {tab("board", "Board")}
        </nav>
        <span className="text-sm" style={{ color: "var(--bt-muted)" }}>
          {liveCount} live · {mode === "list" ? "sorted by what needs you first" : "drag to change stage"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
          style={{ color: "var(--bt-on-accent)" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New trade
        </button>
      </header>

      <main className={`flex-1 overflow-auto px-8 pb-8 ${mode === "list" ? "pt-5" : "pt-6"}`}>
        {loadError && <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-error)" }}>{loadError}</p>}
        {actionError && <p role="alert" className="mb-4 text-sm" style={{ color: "var(--color-error)" }}>{actionError}</p>}
        {mode === "list"
          ? <TradesList trades={trades} today={today} onOpen={setEditing} />
          : <TradesBoard trades={trades} today={today} onOpen={setEditing} onMove={move} />}
      </main>

      {editing && (
        <TradeEditor
          key={editing === "new" ? "new" : editing.id}
          trade={editing === "new" ? null : editing}
          owners={owners}
          today={today}
          onClose={() => setEditing(null)}
          onSave={save}
          onOpenEvidence={editing !== "new" && onOpenEntry
            ? () => { onOpenEntry("bulk_trade", editing.id); setEditing(null); }
            : undefined}
        />
      )}
    </div>
  );
}
