"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusyRegion, Sh, ShBlock } from "./bt-shimmer";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import { todayInLondon, type TradeOwner } from "@/lib/bulk-trades";
import { filterSheet, filtersFromRoute, routeFromFilters, sortRows, type SheetFilters, type SheetRow, type SheetSort } from "@/lib/bulk-sheet";
import type { Demand } from "@/lib/bulk-demand";
import { ListingDetail } from "./listing-detail";
import { DemandDialog } from "./demand-editor";
import { OpportunitiesSheet, SheetFilterBar } from "./opportunities-sheet";
import { BulkBoard } from "./bulk-board";
import { ProposalRow } from "./proposal-row";
import { ErrorText, request, buttonClass, buttonStyle, sharedGet } from "./trade-ui";
import { BULK_TRADES_PARAMS, TRADES_PREVIEW_PATH } from "@/lib/bulk-trades-url";

const SHEET_STATE_KEY = "bt-preview-sheet-state";
import { useBulkTradesRoute } from "./use-bulk-trades-route";

type Props = {
  onOpenEntry?: (objectName: string, entryId: string) => void;
  /** Workspace host: open a listing in its own tab. Without it the listing opens in this page. */
  onOpenListing?: (id: string, title?: string) => void;
};

export function TradesPreviewView({ onOpenEntry, onOpenListing }: Props) {
  const { route, navigate } = useBulkTradesRoute(TRADES_PREVIEW_PATH);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [check, setCheck] = useState<CheckStatus>(null);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [acceptedDemand, setAcceptedDemand] = useState<Proposal[]>([]);
  const [showPossible, setShowPossible] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"demand" | null>(null);
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<SheetSort>("newest");
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
      setCheck(data.check ?? null);
      setPossible([...new Map([...(data.possible ?? []), ...(inbox.possible ?? [])].map((item) => [item.id, item])).values()]);
      setAcceptedDemand(inbox.accepted ?? []);
    } catch {
      /* the inbox is secondary: the sheet stays usable without it */
    } finally {
      setInboxLoaded(true);
    }
  }, []);
  const load = useCallback(() => { void loadSheet(); void loadInbox(); }, [loadSheet, loadInbox]);
  useEffect(() => { load(); }, [load]);

  // Coming back to the list, by Back or by the breadcrumb, shows what was just saved.
  const detailOpen = !!route.listing;
  const wasDetailOpen = useRef(false);
  useEffect(() => {
    if (wasDetailOpen.current && !detailOpen) load();
    wasDetailOpen.current = detailOpen;
  }, [detailOpen, load]);

  const filters = useMemo(() => filtersFromRoute(route), [route]);
  const shown = useMemo(() => sortRows(filterSheet(rows, filters), sort), [rows, filters, sort]);
  // Normalised from what the sheet shows, so an older ?tab=demand link keeps its filter through open and back.
  const board = route.tab === "board";
  const filterFields = { ...routeFromFilters(filters), tab: board ? ("board" as const) : null };

  /** Filters refine the current page (replace); opening a record is a new page (push). */
  const setFilters = (next: SheetFilters) => navigate({ ...routeFromFilters(next), tab: filterFields.tab }, "replace");
  const setView = (tab: "board" | null) => navigate({ ...routeFromFilters(filters), tab }, "replace");
  /** In the workspace a record opens in its own tab, so the sheet keeps its filters and place. */
  const openId = (id: string, title?: string) => (onOpenListing ? onOpenListing(id, title) : navigate({ ...filterFields, listing: id }));
  const open = (row: SheetRow) => openId(row.id, row.title);
  const closeDetail = () => navigate(filterFields);

  // In the workspace, switching to a listing tab and back reloads the sheet from a bare URL.
  // Keep the filters and view for this browser session so the sheet comes back as it was left.
  const filterKey = JSON.stringify(filterFields);
  const sheetSaved = useRef(false);
  useEffect(() => {
    if (!onOpenListing || route.listing) return;
    if (!sheetSaved.current) {
      sheetSaved.current = true;
      const params = new URLSearchParams(window.location.search);
      if (!BULK_TRADES_PARAMS.some((key) => params.has(key))) {
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(SHEET_STATE_KEY) ?? "null");
          if (saved && typeof saved === "object") { navigate(saved, "replace"); return; }
        } catch { /* nothing saved: start from the bare page */ }
      }
    }
    try { window.sessionStorage.setItem(SHEET_STATE_KEY, filterKey); } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, onOpenListing, route.listing]);
  /** Saves a listing’s next action in place. */
  async function saveNext(row: SheetRow, text: string | null) {
    await request(`/api/bulk-listings/${row.id}/next`, { method: "PUT", body: JSON.stringify({ next_action: text, next_due: text ? row.next_due : null }) });
    setRows((current) => current.map((item) => (item.key === row.key ? { ...item, next_action: text, next_due: text ? item.next_due : null } : item)));
  }

  if (route.listing) {
    return (
      <div className="bulk-trades bt-preview h-full overflow-auto px-2 pb-3 pt-2">
        <ListingDetail key={route.listing} id={route.listing} today={today} onClose={closeDetail}
          onOpenListing={(id) => navigate({ ...filterFields, listing: id })} />
      </div>
    );
  }

  return (
    <div className="bulk-trades bt-preview flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 px-2 pb-3 pt-5 sm:px-3">
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Bulk Trades</h1>
        <div role="tablist" aria-label="View" className="flex rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {([["List", null], ["Board", "board"]] as const).map(([label, tab]) => (
            <button key={label} type="button" role="tab" aria-selected={(tab === "board") === board} onClick={() => setView(tab)}
              className="h-8 rounded-md px-3 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
              style={(tab === "board") === board ? { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" } : { color: "var(--bt-text-2)" }}>{label}</button>
          ))}
        </div>
        <div className="flex-1" />
        <button type="button" onClick={() => setShowPossible(true)} className={`${buttonClass} h-9 rounded-lg`} style={buttonStyle}>
          <ShBlock on={!inboxLoaded} size={8}>{check && <CheckLine check={check} />}</ShBlock>Inbox · <Sh on={!inboxLoaded} chars={2}>{possible.length}</Sh>
        </button>
        <div className="relative">
          <button type="button" aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((value) => !value)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--bt-accent)] px-3.5 text-sm font-semibold hover:bg-[var(--bt-accent-hover)]"
            style={{ color: "var(--bt-on-accent)" }}>
            <Plus size={16} aria-hidden="true" />Add
          </button>
          {adding && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border p-1 shadow-md" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
              <button type="button" role="menuitem" className="block w-full rounded-md px-3 py-2 text-left text-[13px] hover:bg-[var(--bt-row-hover)]" onClick={() => { setAdding(false); setCreating("demand"); }}>Add demand</button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 overflow-auto px-2 pb-8 pt-2 sm:px-3">
        <ErrorText error={actionError} />
        {board ? (
          <div className="flex flex-col gap-4">
            <SheetFilterBar rows={rows} filters={filters} onFilters={setFilters} hideProgress />
            <BulkBoard shown={shown} loading={!sheetLoaded && !sheetError} error={sheetError} today={today} onOpen={open} />
          </div>
        ) : (
          <OpportunitiesSheet rows={rows} shown={shown} filters={filters} loading={!sheetLoaded && !sheetError} error={sheetError} today={today}
            sort={sort} onSort={setSort} onFilters={setFilters} onOpen={open} onNext={saveNext} />
        )}
      </main>


      <Dialog open={showPossible} onOpenChange={setShowPossible}>
        <DialogContent aria-describedby={undefined} showCloseButton={false} className="bulk-trades bt-preview top-0 left-auto right-0 h-full max-w-2xl translate-x-0 translate-y-0 overflow-auto rounded-lg sm:max-w-2xl block" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
          <header className="mb-4 flex items-center justify-between"><DialogTitle>Inbox · <Sh on={!inboxLoaded} chars={2}>{possible.length}</Sh></DialogTitle><button type="button" onClick={() => setShowPossible(false)}>Close</button></header>
          <ErrorText error={actionError} />
          <BusyRegion busy={!inboxLoaded} label="Loading inbox">{!possible.length && <p className="text-sm"><Sh on={!inboxLoaded} chars={18}>Inbox clear.</Sh></p>}</BusyRegion>
          {possible.map((proposal) => <ProposalRow key={proposal.id} proposal={proposal} onDecided={(decided, action, lotId) => {
            setPossible((current) => current.filter((candidate) => candidate.id !== decided.id));
            if (action === "accept") {
              load();
              if (lotId) { openId(lotId); setShowPossible(false); }
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

      {creating === "demand" && (
        <DemandDialog demand={null} onClose={() => setCreating(null)}
          onSaved={(saved: Demand) => { setCreating(null); openId(saved.id); }} />
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
