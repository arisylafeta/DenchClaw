"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import { todayInLondon, type BulkTrade, type TradeOwner, type TradePatch } from "@/lib/bulk-trades";
import { filterSheet, filtersFromRoute, routeFromFilters, type SheetFilters, type SheetRow } from "@/lib/bulk-sheet";
import type { Demand } from "@/lib/bulk-demand";
import { DemandDetail } from "./demand-detail";
import { DemandDialog } from "./demand-editor";
import { OpportunitiesSheet } from "./opportunities-sheet";
import { ProposalRow } from "./proposal-row";
import { SupplyDetail } from "./supply-page";
import { TradeEditor } from "./trade-editor";
import { TradePage } from "./trade-page";
import { ErrorText, request, buttonClass, buttonStyle, sharedGet } from "./trade-ui";
import { TRADES_PREVIEW_PATH } from "@/lib/bulk-trades-url";
import { useBulkTradesRoute } from "./use-bulk-trades-route";

type Props = {
  onOpenEntry?: (objectName: string, entryId: string) => void;
};

export function TradesPreviewView({ onOpenEntry }: Props) {
  const { route, navigate } = useBulkTradesRoute(TRADES_PREVIEW_PATH);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [owners, setOwners] = useState<TradeOwner[]>([]);
  const [check, setCheck] = useState<CheckStatus>(null);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [acceptedDemand, setAcceptedDemand] = useState<Proposal[]>([]);
  const [showPossible, setShowPossible] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"trade" | "demand" | null>(null);
  const [adding, setAdding] = useState(false);
  const today = todayInLondon();

  // The sheet and the inbox load side by side: the rows never wait on the inbox, nor the inbox on the rows.
  const loadSheet = useCallback(async () => {
    try {
      const data = await sharedGet<{ rows: SheetRow[] }>("/api/bulk-trades/sheet");
      setRows(data.rows);
      setSheetError(null);
      setSheetLoaded(true);
    } catch (err) {
      setSheetError(err instanceof Error ? err.message : "Could not load the sheet.");
    }
  }, []);
  const loadInbox = useCallback(async () => {
    try {
      const [data, inbox] = await Promise.all([
        sharedGet<{ owners: TradeOwner[]; check?: CheckStatus; possible?: Proposal[] }>("/api/bulk-trades?inbox=1"),
        sharedGet<{ possible?: Proposal[]; accepted?: Proposal[] }>("/api/bulk-trades/demand"),
      ]);
      setOwners(data.owners);
      setCheck(data.check ?? null);
      setPossible([...new Map([...(data.possible ?? []), ...(inbox.possible ?? [])].map((item) => [item.id, item])).values()]);
      setAcceptedDemand(inbox.accepted ?? []);
    } catch {
      /* the inbox is secondary: the sheet stays usable without it */
    }
  }, []);
  const load = useCallback(() => { void loadSheet(); void loadInbox(); }, [loadSheet, loadInbox]);
  useEffect(() => { load(); }, [load]);

  // Coming back to the list, by Back or by the breadcrumb, shows what was just saved.
  const detailOpen = !!(route.trade || route.demand || route.supply);
  const wasDetailOpen = useRef(false);
  useEffect(() => {
    if (wasDetailOpen.current && !detailOpen) load();
    wasDetailOpen.current = detailOpen;
  }, [detailOpen, load]);

  const filters = useMemo(() => filtersFromRoute(route), [route]);
  const shown = useMemo(() => filterSheet(rows, filters), [rows, filters]);
  // Normalised from what the sheet shows, so an older ?tab=demand link keeps its filter through open and back.
  const filterFields = routeFromFilters(filters);

  /** Filters refine the current page (replace); opening a record is a new page (push). */
  const setFilters = (next: SheetFilters) => navigate(routeFromFilters(next), "replace");
  const open = (row: SheetRow) => navigate({ ...filterFields, [row.kind]: row.id });
  const closeDetail = () => navigate(filterFields);
  const openTrade = (id: string) => navigate({ ...filterFields, trade: id });
  const openDemand = (id: string) => navigate({ ...filterFields, demand: id });
  const openSupply = (id: string) => navigate({ ...filterFields, supply: id });

  async function createTrade(patch: TradePatch) {
    const { trade } = await request<{ trade: BulkTrade }>("/api/bulk-trades", { method: "POST", body: JSON.stringify(patch) });
    setCreating(null);
    navigate({ ...filterFields, trade: trade.id });
  }

  if (route.trade) {
    return (
      <div className="bulk-trades bt-preview h-full">
        <TradePage
          key={route.trade}
          tradeId={route.trade}
          owners={owners}
          today={today}
          onBack={closeDetail}
          onTradeSaved={() => { void loadSheet(); }}
          onOpenEvidence={onOpenEntry ? () => onOpenEntry("bulk_trade", route.trade!) : undefined}
        />
      </div>
    );
  }
  if (route.demand) {
    return (
      <div className="bulk-trades bt-preview h-full overflow-auto px-2 pb-3 pt-2">
        <DemandDetail key={route.demand} id={route.demand} today={today} onClose={closeDetail}
          onOpenTrade={openTrade} onOpenSupply={openSupply} onOpenDemand={openDemand} />
      </div>
    );
  }

  return (
    <div className="bulk-trades bt-preview flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 pb-3 pt-5 sm:px-8">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Trades Preview</h1>
        <div className="flex-1" />
        <button type="button" onClick={() => setShowPossible(true)} className={`${buttonClass} h-9 rounded-lg`} style={buttonStyle}>
          {check && <CheckLine check={check} />}Inbox · {possible.length}
        </button>
        <div className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((value) => !value)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
            style={{ color: "var(--bt-on-accent)" }}>
            <Plus size={16} aria-hidden="true" />Add
          </button>
          {adding && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border p-1 shadow-md" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
              <button type="button" role="menuitem" className="block w-full rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--bt-row-hover)]" onClick={() => { setAdding(false); setCreating("trade"); }}>New trade</button>
              <button type="button" role="menuitem" className="block w-full rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--bt-row-hover)]" onClick={() => { setAdding(false); setCreating("demand"); }}>Add demand</button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-4 pb-8 pt-2 sm:px-8">
        <ErrorText error={actionError} />
        <OpportunitiesSheet rows={rows} shown={shown} filters={filters} loading={!sheetLoaded && !sheetError} error={sheetError} today={today}
          onFilters={setFilters} onOpen={open} />
      </main>

      {route.supply && <SupplyDetail key={route.supply} id={route.supply} onClose={closeDetail} onOpenDemand={openDemand} />}

      <Dialog open={showPossible} onOpenChange={setShowPossible}>
        <DialogContent aria-describedby={undefined} showCloseButton={false} className="bulk-trades bt-preview top-0 left-auto right-0 h-full max-w-2xl translate-x-0 translate-y-0 overflow-auto rounded-lg sm:max-w-2xl block" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          <header className="mb-4 flex items-center justify-between"><DialogTitle>Inbox · {possible.length}</DialogTitle><button type="button" onClick={() => setShowPossible(false)}>Close</button></header>
          <ErrorText error={actionError} />
          {!possible.length && <p className="text-sm">Inbox clear.</p>}
          {possible.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDecided={(decided, action, lotId) => {
            setPossible((current) => current.filter((candidate) => candidate.id !== decided.id));
            if (action === "accept") {
              load();
              if (lotId) { navigate({ ...filterFields, trade: lotId }); setShowPossible(false); }
            }
          }} />)}
          {!!acceptedDemand.length && <section className="mt-6" aria-label="Accepted demand">
            <h3 className="mb-2 text-sm">Accepted demand</h3>
            {acceptedDemand.map((proposal) => <div key={proposal.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>{proposal.summary} {proposal.source_url && <a className="underline" href={proposal.source_url}>Source</a>}</span>
              <button type="button" className={buttonClass} style={buttonStyle} onClick={async () => {
                try {
                  await request(`/api/bulk-trades/proposals/${proposal.id}`, { method: "POST", body: JSON.stringify({ action: "undo" }) });
                  setActionError(null);
                  load();
                } catch (err) { setActionError(err instanceof Error ? err.message : "Undo refused."); }
              }}>Undo</button>
            </div>)}
          </section>}
        </DialogContent>
      </Dialog>

      {creating === "trade" && <TradeEditor trade={null} owners={owners} today={today} onClose={() => setCreating(null)} onSave={createTrade} />}
      {creating === "demand" && (
        <DemandDialog demand={null} onClose={() => setCreating(null)}
          onSaved={(saved: Demand) => { setCreating(null); navigate({ ...filterFields, demand: saved.id }); }} />
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
