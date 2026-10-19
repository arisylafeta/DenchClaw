"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { activeBulkTradesTab, type BulkTradesRoute, type BulkTradesTab } from "@/lib/bulk-trades-url";
import { useBulkTradesRoute } from "./use-bulk-trades-route";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import {
  HOLD_STAGE,
  todayInLondon,
  type BulkTrade,
  type TradeOwner,
  type TradePatch,
  type TradeStage,
} from "@/lib/bulk-trades";
import { DemandPage } from "./demand-page";
import { SupplyPage } from "./supply-page";
import { HoldDialog } from "./hold-dialog";
import { TradeEditor } from "./trade-editor";
import { TradePage } from "./trade-page";
import { ProposalRow } from "./proposal-row";
import { ErrorText, request, buttonClass, buttonStyle, sharedGet } from "./trade-ui";
import { TradesBoard } from "./trades-board";
import { TodayDashboard } from "./today-dashboard";

const MODE_KEY = "bulk-trades:view";

/** The viewer's last tab, used only when the URL names none. */
function storedTab(): BulkTradesTab {
  try {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === "board") return "trades";
    return stored === "demand" || stored === "supply" || stored === "trades" ? stored : "today";
  } catch {
    return "today";
  }
}

type Props = {
  onOpenEntry?: (objectName: string, entryId: string) => void;
};

export function BulkTradesView({ onOpenEntry }: Props) {
  const { route, navigate } = useBulkTradesRoute();
  const [fallbackTab, setFallbackTab] = useState<BulkTradesTab>("today");
  const mode = activeBulkTradesTab(route, fallbackTab);
  const [trades, setTrades] = useState<BulkTrade[]>([]);
  const [owners, setOwners] = useState<TradeOwner[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tradesLoaded, setTradesLoaded] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [check, setCheck] = useState<CheckStatus>(null);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [acceptedDemand, setAcceptedDemand] = useState<Proposal[]>([]);
  const [showPossible, setShowPossible] = useState(false);
  const openTradeId = route.trade;
  const [demandRevision, setDemandRevision] = useState(0);
  const [holding, setHolding] = useState<BulkTrade | null>(null);
  const today = todayInLondon();

  // Read after mount so server and client render the same first frame.
  useEffect(() => { setFallbackTab(storedTab()); }, []);

  /** Opens a trade over the current page; Back returns to exactly what was showing. */
  const pinned = { ...route, tab: route.tab ?? mode };
  const setOpenTradeId = useCallback((id: string | null) => navigate({ ...pinned, trade: id }), [navigate, pinned.tab, route]); // eslint-disable-line react-hooks/exhaustive-deps
  const openDemand = (id: string) => navigate({ demand: id });
  const openSupply = (id: string) => navigate({ supply: id });
  /** Selecting a record is a new page (push); filters and search refine the current one (replace). */
  const updateRoute = useCallback((patch: Partial<BulkTradesRoute>, mode: "push" | "replace") =>
    navigate({ ...pinned, ...patch }, mode), [navigate, route, pinned.tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [data, inbox] = await Promise.all([
        sharedGet<{ trades: BulkTrade[]; owners: TradeOwner[]; check?: CheckStatus; possible?: Proposal[] }>("/api/bulk-trades"),
        sharedGet<{ possible?: Proposal[]; accepted?: Proposal[] }>("/api/bulk-trades/demand"),
      ]);
      if (seq !== loadSeq.current) return; // a newer load is already on its way
      setTrades(data.trades);
      setOwners(data.owners);
      setCheck(data.check ?? null);
      setPossible([...new Map([...(data.possible ?? []), ...(inbox.possible ?? [])].map((item) => [item.id, item])).values()]);
      setAcceptedDemand(inbox.accepted ?? []);
      setLoadError(null);
      setTradesLoaded(true);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load trades.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function switchMode(next: BulkTradesTab) {
    navigate({ tab: next });
    try { window.localStorage.setItem(MODE_KEY, next); } catch { /* per-viewer convenience only */ }
  }

  const replace = useCallback((trade: BulkTrade) =>
    setTrades((current) => current.map((candidate) => (candidate.id === trade.id ? trade : candidate))), []);

  /** Creates a trade and opens its page. */
  async function create(patch: TradePatch) {
    const { trade } = await request<{ trade: BulkTrade }>("/api/bulk-trades", { method: "POST", body: JSON.stringify(patch) });
    setTrades((current) => [...current, trade]);
    setCreating(false);
    navigate({ ...pinned, trade: trade.id });
  }

  async function move(trade: BulkTrade, stage: TradeStage, hold?: { hold_until: string; hold_reason: string }) {
    if (stage === HOLD_STAGE && !hold) {
      setHolding(trade); // a hold needs a date and a reason first
      return;
    }
    setActionError(null);
    replace({ ...trade, trade_stage: stage, ...hold });
    try {
      const { trade: saved } = await request<{ trade: BulkTrade }>(`/api/bulk-trades/${encodeURIComponent(trade.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ trade_stage: stage, ...hold }),
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
          onBack={() => { navigate({ ...pinned, trade: null }); void load(); }}
          onTradeSaved={replace}
          onOpenEvidence={onOpenEntry ? () => onOpenEntry("bulk_trade", openTradeId) : undefined}
        />
      </div>
    );
  }

  const open = (trade: BulkTrade) => setOpenTradeId(trade.id);
  const tab = (value: BulkTradesTab, label: string) => (
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
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Bulk Trades</h1>
        <nav aria-label="View" className="ml-2 flex rounded-none p-[3px]" style={{ background: "var(--bt-segment)" }}>
          {tab("today", "Today")}
          {tab("trades", "Trades")}
          {tab("demand", "Demand")}
          {tab("supply", "Supply")}
        </nav>
        <div className="flex-1" />
        <button type="button" onClick={() => setShowPossible(true)} className={`${buttonClass} h-9`} style={buttonStyle}>
          {check && <CheckLine check={check} />}Inbox · {possible.length}
        </button>
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

      <main className="flex-1 overflow-auto px-8 pb-8 pt-5">
        <ErrorText error={loadError} />
        <ErrorText error={actionError} />
        {mode === "demand"
          ? <DemandPage key={demandRevision} today={today} onOpenTrade={setOpenTradeId} route={route} onRouteChange={updateRoute} onOpenSupply={openSupply} />
          : mode === "supply"
            ? <SupplyPage route={route} onRouteChange={updateRoute} onOpenDemand={openDemand} />
            : mode === "today"
              ? tradesLoaded
                ? <TodayDashboard trades={trades} today={today} demandRevision={demandRevision} proposalCount={possible.length} onOpenTrade={setOpenTradeId} onOpenDemand={openDemand} onOpenInbox={() => setShowPossible(true)} />
                : <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{loadError ? "Today's work unavailable." : "Loading today's work…"}</p>
              : <TradesBoard trades={trades} today={today} onOpen={open} onMove={move} />}
      </main>
      <Dialog open={showPossible} onOpenChange={setShowPossible}>
        <DialogContent aria-describedby={undefined} showCloseButton={false} className="bulk-trades top-0 left-auto right-0 h-full max-w-2xl translate-x-0 translate-y-0 overflow-auto rounded-none sm:max-w-2xl block" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          <header className="mb-4 flex items-center justify-between"><DialogTitle>Inbox · {possible.length}</DialogTitle><button type="button" onClick={() => setShowPossible(false)}>Close</button></header>
          <ErrorText error={actionError} />
          {!possible.length && <p className="text-sm">Inbox clear.</p>}
          {possible.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDecided={(decided, action, lotId) => {
            setPossible((current) => current.filter((candidate) => candidate.id !== decided.id));
            if (action === "accept") {
              if (decided.kind === "possible_demand") setDemandRevision((revision) => revision + 1);
              void load();
              if (lotId) { navigate({ ...pinned, trade: lotId }); setShowPossible(false); }
            }
          }} />)}
          {!!acceptedDemand.length && <section className="mt-6" aria-label="Accepted demand">
            <h3 className="mb-2 text-sm">Accepted demand</h3>
            {acceptedDemand.map((proposal) => <div key={proposal.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>{proposal.summary} {proposal.source_url && <a className="underline" href={proposal.source_url}>Source</a>}</span>
              <button type="button" className={buttonClass} style={buttonStyle} onClick={async () => {
                try {
                  await request(`/api/bulk-trades/proposals/${proposal.id}`, {method:"POST",body:JSON.stringify({action:"undo"})});
                  setActionError(null);
                  setDemandRevision(revision => revision + 1);
                  await load();
                } catch (err) { setActionError(err instanceof Error ? err.message : "Undo refused."); }
              }}>Undo</button>
            </div>)}
          </section>}
        </DialogContent>
      </Dialog>

      {holding && (
        <HoldDialog trade={holding} today={today} onClose={() => setHolding(null)}
          onSave={async (hold) => { const trade = holding; setHolding(null); await move(trade, HOLD_STAGE, hold); }} />
      )}
      {creating && (
        <TradeEditor trade={null} owners={owners} today={today} onClose={() => setCreating(false)} onSave={create} />
      )}
    </div>
  );
}

/** Inbox-check health stays visible without competing with the work. */
function CheckLine({ check }: { check: NonNullable<CheckStatus> }) {
  const failed = check.status === "failed";
  const title = `${failed ? "Check failed" : "Checked"} ${ukTime(check.last_run_at)} · next ${nextCheckTime()}${check.error ? ` · ${check.error}` : ""}`;
  return (
    <span role="img" aria-label={title} title={title} className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: failed ? "var(--bt-red)" : "var(--bt-ok)" }} />
  );
}
