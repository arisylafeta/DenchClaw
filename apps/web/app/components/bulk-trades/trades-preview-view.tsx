"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusyRegion, Sh, ShBlock } from "./bt-shimmer";
import { Plus } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import { todayInLondon, type TradeOwner } from "@/lib/bulk-trades";
import { filterSheet, filtersFromRoute, NO_FILTERS, routeFromFilters, sortRows, type SheetFilters, type SheetRow, type SheetSort } from "@/lib/bulk-sheet";
import { DEMAND_STAGES, SUPPLY_STAGES, progressFor } from "@/lib/bulk-listing";
import { boardRows } from "@/lib/bulk-desk";
import type { DealOwner } from "@/lib/bulk-owner";
import type { Demand } from "@/lib/bulk-demand";
import { ListingDetail } from "./listing-detail";
import { DemandDialog } from "./demand-editor";
import { OpportunitiesSheet, SheetFilterBar } from "./opportunities-sheet";
import { BulkBoard } from "./bulk-board";
import { TodayView } from "./today-view";
import { ProposalRow } from "./proposal-row";
import { ErrorText, request, buttonClass, buttonStyle, sharedGet } from "./trade-ui";
import { BULK_TRADES_PARAMS, TRADES_PREVIEW_PATH, previewTab, type PreviewTab } from "@/lib/bulk-trades-url";

const SHEET_STATE_KEY = "bt-preview-sheet-state";
const TABS: [PreviewTab, string][] = [["today", "Today"], ["demand", "Requests"], ["supply", "Supply"], ["board", "Board"]];
/** The drivers, in the order the header shows them. */
const DRIVERS: (DealOwner | "all")[] = ["all", "Alex", "Sean", "Ari"];
const segmentOn = { background: "var(--bt-surface)", color: "var(--bt-text)", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.08)" } as const;
const segmentOff = { color: "var(--bt-text-2)" } as const;
const segmentButton = "h-8 shrink-0 rounded-md px-3 text-[13px] whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]";
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

  // Today, Requests (demand), Supply or Board. Requests and Supply lock the sheet to their side; older links with only
  // side=buyer|seller land on them. The side is written to the URL only on the Board, where it is still a filter.
  const tab = previewTab(route);
  const filters = useMemo<SheetFilters>(() => {
    const base = filtersFromRoute(route);
    // A Progress value from an older link or another tab is mapped to this tab's stages, or dropped. The Board has no Progress filter.
    const kind = tab === "demand" ? "demand" : tab === "supply" ? "supply" : null;
    const progress = kind && base.progress !== "all" ? progressFor(base.progress, kind) ?? "all" : kind ? base.progress : "all";
    return { ...base, progress, side: tab === "demand" ? "buyer" : tab === "supply" ? "seller" : tab === "board" ? base.side : "all" };
  }, [route, tab]);
  const tabRows = useMemo(() => tab === "demand" ? rows.filter((row) => row.kind === "demand")
    : tab === "supply" ? rows.filter((row) => row.kind === "supply") : tab === "board" ? boardRows(rows) : rows, [rows, tab]);
  const shown = useMemo(() => tab === "today" ? filterSheet(rows, { ...NO_FILTERS, owner: filters.owner }) : sortRows(filterSheet(tabRows, filters), sort), [rows, tabRows, filters, sort, tab]);
  const routeFields = (next: SheetFilters, nextTab: PreviewTab) => ({ ...routeFromFilters(next), side: nextTab === "board" && next.side !== "all" ? next.side : null, tab: nextTab === "today" ? null : nextTab });
  const filterFields = routeFields(filters, tab);

  /** Filters refine the current page (replace); opening a record is a new page (push). */
  const setFilters = (next: SheetFilters) => navigate(routeFields(next, tab), "replace");
  /** A tab starts with its own filters; only the driver carries over. */
  const setTab = (next: PreviewTab) => navigate(routeFields({ ...NO_FILTERS, owner: filters.owner }, next), "replace");
  const setOwner = (owner: DealOwner | "all") => navigate(routeFields({ ...filters, owner }, tab), "replace");
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-2 pb-2 pt-3 sm:px-3">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">Bulk Trades</h1>
        <div role="tablist" aria-label="View" className="flex max-w-full overflow-x-auto rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
              className={segmentButton} style={tab === value ? segmentOn : segmentOff}>{label}</button>
          ))}
        </div>
        <div role="group" aria-label="Driver" className="flex max-w-full overflow-x-auto rounded-lg p-0.5" style={{ background: "var(--bt-segment)" }}>
          {DRIVERS.map((value) => (
            <button key={value} type="button" aria-pressed={filters.owner === value} onClick={() => setOwner(value)}
              className={segmentButton} style={filters.owner === value ? segmentOn : segmentOff}>{value === "all" ? "All" : value}</button>
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

      <main className="flex-1 overflow-auto px-2 pb-8 pt-1 sm:px-3">
        <ErrorText error={actionError} />
        {tab === "today" ? (
          <TodayView rows={shown} owner={filters.owner} loading={!sheetLoaded && !sheetError} error={sheetError} today={today}
            onOpen={open} onNext={saveNext} onOpenBoard={() => setTab("board")} />
        ) : tab === "board" ? (
          <div className="flex flex-col gap-4">
            <SheetFilterBar rows={tabRows} filters={filters} onFilters={setFilters} hideProgress />
            <BulkBoard shown={shown} loading={!sheetLoaded && !sheetError} error={sheetError} today={today} onOpen={open} />
          </div>
        ) : (
          <OpportunitiesSheet key={tab} rows={tabRows} shown={shown} filters={filters} loading={!sheetLoaded && !sheetError} error={sheetError} today={today}
            sort={sort} onSort={setSort} onFilters={setFilters} onOpen={open} onNext={saveNext} hideSide stages={tab === "demand" ? DEMAND_STAGES : SUPPLY_STAGES} />
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
