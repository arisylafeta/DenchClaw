"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BusyRegion, Sh, ShBlock } from "./bt-shimmer";
import { Users } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { nextCheckTime, ukTime, type CheckStatus, type Proposal } from "@/lib/bulk-trade-details";
import { todayInLondon, type TradeOwner } from "@/lib/bulk-trades";
import { filterSheet, filtersFromRoute, NO_FILTERS, routeFromFilters, sortRows, type SheetFilters, type SheetRow, type SheetSort } from "@/lib/bulk-sheet";
import { DEMAND_MAIN_STAGES, DEMAND_STAGES, SUPPLY_MAIN_STAGES, SUPPLY_STAGES, progressFor } from "@/lib/bulk-listing";
import { boardTabRows, deskCounts } from "@/lib/bulk-desk";
import type { AbandonReason } from "@/lib/bulk-abandon";
import { activeFilterCount } from "@/lib/bulk-overview";
import { dealOwner, type DealOwner } from "@/lib/bulk-owner";
import type { Demand } from "@/lib/bulk-demand";
import { ListingDetail } from "./listing-detail";
import { DemandDialog } from "./demand-editor";
import { SheetFilterBar } from "./opportunities-sheet";
import { OverviewList, usePopover } from "./overview-list";
import css from "./bulk-overview.module.css";
import { BulkBoard } from "./bulk-board";
import { TodayView } from "./today-view";
import type { NextFields } from "./next-action";
import { ProposalRow } from "./proposal-row";
import { ErrorText, request, buttonClass, buttonStyle, sharedGet } from "./trade-ui";
import { BULK_TRADES_PARAMS, TRADES_PREVIEW_PATH, previewTab, type PreviewTab } from "@/lib/bulk-trades-url";

const SHEET_STATE_KEY = "bt-preview-sheet-state";
const TABS: [PreviewTab, string][] = [["today", "Today"], ["demand", "Requests"], ["supply", "Supply"], ["board", "Deals"]];
/** The drivers, in the order the header shows them. */
const DRIVERS: (DealOwner | "all")[] = ["all", "Alex", "Sean", "Ari"];
/** The owner picker's initial, in the mock's colours; All owners shows a group icon. */
const OWNER_LOOK: Record<DealOwner, { text: string; bg: string; fg: string }> = {
  Sean: { text: "S", bg: "var(--ov-av-bg)", fg: "var(--ov-blue)" },
  Alex: { text: "A", bg: "var(--ov-text)", fg: "var(--ov-card)" },
  Ari: { text: "Ar", bg: "var(--bt-purple-bg)", fg: "var(--bt-purple)" },
};
function OwnerInitial({ owner }: { owner: DealOwner | "all" }) {
  const look = owner === "all" ? null : OWNER_LOOK[owner];
  return <span className={css.av} aria-hidden="true" style={look ? { background: look.bg, color: look.fg, fontSize: look.text.length > 1 ? 10 : undefined } : undefined}>
    {look ? look.text : <Users size={13} strokeWidth={2.25} />}
  </span>;
}
import { useBulkTradesRoute } from "./use-bulk-trades-route";

type Props = {
  onOpenEntry?: (objectName: string, entryId: string) => void;
  /** Workspace host: open a listing in its own tab. Without it the listing opens in this page. */
  onOpenListing?: (id: string, title?: string) => void;
};

export function TradesPreviewView({ onOpenEntry, onOpenListing }: Props) {
  const { route, navigate } = useBulkTradesRoute(TRADES_PREVIEW_PATH);
  const [rows, setRows] = useState<SheetRow[]>([]);
  /** The Deals board's Abandoned column. */
  const [abandoned, setAbandoned] = useState<SheetRow[]>([]);
  const [sheetLoaded, setSheetLoaded] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [inboxLoaded, setInboxLoaded] = useState(false);
  const [check, setCheck] = useState<CheckStatus>(null);
  const [possible, setPossible] = useState<Proposal[]>([]);
  const [acceptedDemand, setAcceptedDemand] = useState<Proposal[]>([]);
  const [showPossible, setShowPossible] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState<"demand" | null>(null);
  const add = usePopover();
  const filterPop = usePopover();
  const [sort, setSort] = useState<SheetSort>("urgent");
  const today = todayInLondon();

  // The sheet and the inbox load side by side: the rows never wait on the inbox, nor the inbox on the rows.
  const loadSheet = useCallback(async () => {
    try {
      const data = await sharedGet<{ rows: SheetRow[]; abandoned?: SheetRow[] }>("/api/bulk-trades/sheet");
      setRows(data.rows);
      setAbandoned(data.abandoned ?? []);
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
    : tab === "supply" ? rows.filter((row) => row.kind === "supply") : tab === "board" ? boardTabRows(rows) : rows, [rows, tab]);
  // The list tabs group and order their own rows (OverviewList); the Board keeps the chosen order.
  const shown = useMemo(() => tab === "today" ? filterSheet(rows, { ...NO_FILTERS, owner: filters.owner }) : tab === "board" ? sortRows(filterSheet(tabRows, filters), sort) : filterSheet(tabRows, filters), [rows, tabRows, filters, sort, tab]);
  const shownAbandoned = useMemo(() => tab === "board" ? filterSheet(abandoned, filters) : [], [abandoned, filters, tab]);
  /** What each tab holds for the chosen driver, shown beside its name. */
  const tabCounts = useMemo(() => {
    const counts = deskCounts(filterSheet(rows, { ...NO_FILTERS, owner: filters.owner }));
    return { today: null, demand: counts.requests, supply: counts.supply, board: counts.deals } as Record<PreviewTab, number | null>;
  }, [rows, filters.owner]);
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
  /** A list row saved a change (next action, date, driver or chance): update it in place. */
  function updateRow(row: SheetRow, patch: Partial<SheetRow>) {
    setRows((current) => current.map((item) => (item.key === row.key ? { ...item, ...patch } : item)));
  }

  /** Dropped on Abandoned: close it with the reason, move the card at once, then reload (its paired listing may leave the board too). */
  async function abandon(row: SheetRow, reason: AbandonReason, note: string) {
    await request(`/api/bulk-listings/${encodeURIComponent(row.id)}/abandon`, { method: "POST", body: JSON.stringify({ reason, note: note || null }) });
    setRows((current) => current.filter((item) => item.key !== row.key));
    setAbandoned((current) => [{ ...row, abandoned: { reason, at: new Date().toISOString() } }, ...current.filter((item) => item.key !== row.key)]);
    setActionError(null);
    void loadSheet();
  }

  /** Dragged out of Abandoned: reopen it; the reload puts it in the column its stage says (its offers may come back). */
  async function reopen(row: SheetRow) {
    setAbandoned((current) => current.filter((item) => item.key !== row.key));
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(row.id)}/abandon`, { method: "DELETE" });
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not reopen it.");
    } finally {
      void loadSheet();
    }
  }

  /** A Today row changed its action, date or driver: update it in place. */
  function updateNext(row: SheetRow, next: NextFields) {
    setRows((current) => current.map((item) => (item.key === row.key ? { ...item, next_action: next.next_action, next_due: next.next_due, owner: next.owner } : item)));
  }

  if (route.listing) {
    return (
      <div className="bulk-trades bt-preview h-full overflow-auto px-2 pb-3 pt-2">
        <ListingDetail key={route.listing} id={route.listing} today={today} onClose={closeDetail}
          onOpenListing={(id) => navigate({ ...filterFields, listing: id })} />
      </div>
    );
  }

  const sideLocked = tab !== "board";
  const filterCount = activeFilterCount(filters, sideLocked);
  const searching = filters.query.trim() !== "";
  return (
    <div className={`bulk-trades bt-preview h-full overflow-auto ${css.page}`}>
      <div className={css.inner}>
      <header className={css.header}>
        <div className={css.titleRow}>
          <h1 className={css.title}>Bulk Trades</h1>
          <div className={css.headActions}>
            <button type="button" onClick={() => setShowPossible(true)} className={`${css.btn} ${css.btnGhost}`} aria-label={inboxLoaded ? `Inbox · ${possible.length}` : "Inbox"}>
              <ShBlock on={!inboxLoaded} size={8}>{check && <CheckLine check={check} />}</ShBlock>Inbox<span className={css.muted} style={{ fontWeight: 500 }}><Sh on={!inboxLoaded} chars={2}>{possible.length}</Sh></span>
            </button>
            <span className={css.popWrap} ref={add.wrap}>
              <button ref={add.trigger} type="button" aria-haspopup="menu" aria-expanded={add.open} onClick={() => add.setOpen(!add.open)} className={`${css.btn} ${css.btnPri}`}>
                <span aria-hidden="true">+</span> Add
              </button>
              {add.open && (
                <div role="menu" className={`${css.popover} ${css.menu}`}>
                  <button type="button" role="menuitem" className={css.menuItem} onClick={() => { add.setOpen(false); setCreating("demand"); }}>Add demand</button>
                </div>
              )}
            </span>
          </div>
        </div>
        <div className={css.bar}>
          <nav role="tablist" aria-label="View" className={css.tabs}>
            {TABS.map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
                {label}{tabCounts[value] != null && sheetLoaded && <><span className="sr-only">, </span><span data-tab-count className={css.n}>{tabCounts[value]}</span></>}
              </button>
            ))}
          </nav>
          <div className={css.tools}>
            <label className={css.owner}>
              <OwnerInitial owner={filters.owner} />
              <select aria-label="Owner" value={filters.owner} onChange={(event) => setOwner((dealOwner(event.target.value) ?? "all"))}>
                {DRIVERS.map((value) => <option key={value} value={value}>{value === "all" ? "All owners" : value}</option>)}
              </select>
              <svg className={css.chev} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true" style={{ color: "var(--ov-sub)" }}><path d="M6 9l6 6 6-6" /></svg>
            </label>
            {tab !== "today" && <>
              <label className={css.search}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" style={{ color: "var(--ov-muted)", flex: "none" }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input type="search" aria-label="Search buyers, offers and trades" placeholder="Search" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} />
              </label>
              <span className={css.popWrap} ref={filterPop.wrap} style={{ position: "static" }}>
                <button ref={filterPop.trigger} type="button" className={css.btn} aria-haspopup="dialog" aria-expanded={filterPop.open}
                  aria-label={filterCount ? `Filters, ${filterCount} on` : "Filters"} onClick={() => filterPop.setOpen(!filterPop.open)}>
                  Filters{filterCount > 0 && <span className={css.badge} data-filter-count>{filterCount}</span>}
                </button>
                {filterPop.open && (
                  <div role="dialog" aria-label="Filters" className={`${css.popover} ${css.filters}`}>
                    <div className={css.filtersHead}><span>Filters</span>
                      <button type="button" className={`${css.btn} ${css.btnGhost}`} onClick={() => filterPop.setOpen(false)}>Done</button></div>
                    <SheetFilterBar rows={tabRows} filters={filters} onFilters={setFilters} hideSearch hideSide={sideLocked} hideProgress={tab === "board"}
                      sort={tab === "board" ? undefined : sort} onSort={tab === "board" ? undefined : setSort}
                      stages={tab === "demand" ? DEMAND_STAGES : tab === "supply" ? SUPPLY_STAGES : undefined}
                      mainStages={tab === "demand" ? DEMAND_MAIN_STAGES : tab === "supply" ? SUPPLY_MAIN_STAGES : undefined} />
                  </div>
                )}
              </span>
            </>}
          </div>
        </div>
      </header>

      <main className="min-w-0">
        <ErrorText error={actionError} />
        {tab === "today" ? (
          <TodayView rows={shown} owner={filters.owner} loading={!sheetLoaded && !sheetError} error={sheetError} today={today}
            onOpen={open} onUpdate={updateNext} onOpenBoard={() => setTab("board")}
            onOpenCompany={onOpenEntry ? (id) => onOpenEntry("company", id) : undefined} />
        ) : tab === "board" ? (
          <BulkBoard shown={shown} abandoned={shownAbandoned} loading={!sheetLoaded && !sheetError} error={sheetError} today={today} onOpen={open}
            onAbandon={abandon} onReopen={(row) => void reopen(row)} />
        ) : (
          <OverviewList key={tab} rows={shown} loading={!sheetLoaded && !sheetError} error={sheetError} today={today} owner={filters.owner} sort={sort}
            filtered={searching || filterCount > 0} onOpen={open} onUpdate={updateRow} />
        )}
      </main>
      </div>

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
