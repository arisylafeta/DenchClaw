/**
 * Bulk Trades URL model: the one parser and builder for every Bulk Trades link.
 *
 * A Bulk Trades page is `/?path=bulk_trade` plus the params below. The shell owns `path`;
 * this module owns everything else, so shell navigation, chat links and the page agree.
 *
 *   Tab:        /?path=bulk_trade&tab=today|trades|demand|supply
 *   Preview:    /?path=~trades-preview&tab=demand|supply|board&owner=Alex|Sean|Ari  (no tab is Today)
 *   Trade:      /?path=bulk_trade&trade=<id>
 *   Demand:     /?path=bulk_trade&demand=<id>      (list: &tab=demand&status=open|qualifying|closed&q=…&category=…)
 *   Supply:     /?path=bulk_trade&supply=<id>      (list: &tab=supply&status=open|closed&q=…)
 */

export const BULK_TRADES_PATH = "bulk_trade";
/**
 * The Trades Preview page: the same records in one sheet, under its own path and link space. Its links
 * use listing=<id> and accept the legacy trade/demand/supply params without leaving Preview.
 */
export const TRADES_PREVIEW_PATH = "~trades-preview";
/** One listing open in its own workspace tab: `~trades-preview/listing/<id>`. The id keeps any `:` it has. */
const TRADE_LISTING_PREFIX = `${TRADES_PREVIEW_PATH}/listing/`;
export function tradeListingPath(id: string): string { return `${TRADE_LISTING_PREFIX}${id}`; }
export function parseTradeListingPath(path: string): string | null {
  if (!path.startsWith(TRADE_LISTING_PREFIX)) return null;
  const id = path.slice(TRADE_LISTING_PREFIX.length);
  return /^[A-Za-z0-9_:.\-]{1,200}$/.test(id) ? id : null;
}
const PAGES: readonly string[] = [BULK_TRADES_PATH, TRADES_PREVIEW_PATH];

export type BulkTradesTab = "today" | "trades" | "demand" | "supply" | "board";

export type BulkTradesRoute = {
  /** Explicit tab from the URL; null lets the page pick the viewer's last tab. */
  tab: BulkTradesTab | null;
  listing: string | null;
  trade: string | null;
  demand: string | null;
  supply: string | null;
  /** List filters (demand and supply lists only). */
  status: string | null;
  query: string | null;
  category: string | null;
  /** Trades Preview sheet filters. */
  side: string | null;
  progress: string | null;
  company: string | null;
  /** Whose move it is: us or them. */
  waiting: string | null;
  /** Trades Preview: the driver (deal owner) whose work to show. */
  owner: string | null;
};

const SHELL_PARAMS = ["terminal", "browse", "hidden"] as const;
const TABS: BulkTradesTab[] = ["today", "trades", "demand", "supply", "board"];
export const BULK_TRADES_PARAMS = ["tab", "listing", "trade", "demand", "supply", "status", "q", "category", "side", "progress", "company", "waiting", "owner"] as const;

const EMPTY: BulkTradesRoute = { tab: null, listing: null, trade: null, demand: null, supply: null, status: null, query: null, category: null, side: null, progress: null, company: null, waiting: null, owner: null };

export function parseBulkTradesRoute(search: string | URLSearchParams): BulkTradesRoute {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const tab = params.get("tab") as BulkTradesTab | null;
  return {
    tab: tab && TABS.includes(tab) ? tab : null,
    listing: params.get("listing") || (params.get("path") === TRADES_PREVIEW_PATH ? params.get("trade") || params.get("demand") || params.get("supply") : null) || null,
    trade: params.get("trade") || null,
    demand: params.get("demand") || null,
    supply: params.get("supply") || null,
    status: params.get("status") || null,
    query: params.get("q") || null,
    category: params.get("category") || null,
    side: params.get("side") || null,
    progress: params.get("progress") || null,
    company: params.get("company") || null,
    waiting: params.get("waiting") || null,
    owner: params.get("owner") || null,
  };
}

/** The tab a route shows. A selected supply or demand record implies its tab. */
export function activeBulkTradesTab(route: BulkTradesRoute, fallback: BulkTradesTab): BulkTradesTab {
  if (route.supply) return "supply";
  if (route.demand) return "demand";
  return route.tab ?? fallback;
}

/** The four Trades Preview tabs. Requests is the demand sheet, Supply the supply sheet. */
export type PreviewTab = "today" | "demand" | "supply" | "board";

/**
 * The Trades Preview tab a route shows. No tab is Today. Older links keep working: tab=trades is the Board,
 * and a link with no tab but side=buyer or side=seller (the old mixed sheet) opens Requests or Supply.
 */
export function previewTab(route: Pick<BulkTradesRoute, "tab" | "side">): PreviewTab {
  if (route.tab === "board" || route.tab === "trades") return "board";
  if (route.tab === "demand" || route.tab === "supply" || route.tab === "today") return route.tab;
  if (route.side === "buyer") return "demand";
  if (route.side === "seller") return "supply";
  return "today";
}

/** Build the params for a route (without `path`), omitting empty values. */
export function bulkTradesParams(patch: Partial<BulkTradesRoute>): URLSearchParams {
  const route = { ...EMPTY, ...patch };
  const params = new URLSearchParams();
  if (route.tab) params.set("tab", route.tab);
  if (route.listing) params.set("listing", route.listing);
  if (route.trade) params.set("trade", route.trade);
  if (route.demand) params.set("demand", route.demand);
  if (route.supply) params.set("supply", route.supply);
  if (route.status) params.set("status", route.status);
  if (route.query) params.set("q", route.query);
  if (route.category) params.set("category", route.category);
  if (route.side) params.set("side", route.side);
  if (route.progress) params.set("progress", route.progress);
  if (route.company) params.set("company", route.company);
  if (route.waiting) params.set("waiting", route.waiting);
  if (route.owner) params.set("owner", route.owner);
  return params;
}

/** Shareable link to a Bulk Trades page or record. */
export function buildBulkTradesUrl(patch: Partial<BulkTradesRoute> = {}, current?: URLSearchParams, page: string = BULK_TRADES_PATH): string {
  const params = new URLSearchParams({ path: page });
  // Shell state (terminal, browse folder, hidden files) is not part of the destination; keep it.
  if (current) for (const key of SHELL_PARAMS) if (current.has(key)) params.set(key, current.get(key)!);
  const destination = page === TRADES_PREVIEW_PATH
    ? { ...patch, listing: patch.listing || patch.trade || patch.demand || patch.supply,
      trade: null, demand: null, supply: null }
    : patch;
  for (const [key, value] of bulkTradesParams(destination)) params.set(key, value);
  return `/?${params.toString()}`;
}

/** True when the href is a link to the Bulk Trades page (any record or filter). */
export function isBulkTradesHref(href: string): boolean {
  try {
    return new URL(href, "https://app.invalid").searchParams.get("path") === BULK_TRADES_PATH;
  } catch {
    return false;
  }
}

/** True when the href is a link to the Trades Preview page (any record or filter). */
export function isTradesPreviewHref(href: string): boolean {
  try {
    return new URL(href, "https://app.invalid").searchParams.get("path") === TRADES_PREVIEW_PATH;
  } catch {
    return false;
  }
}

/**
 * Carry the Bulk Trades params from the current URL into a query string the shell projected.
 * The shell does not know these params; without this it drops them on every re-projection.
 * Only carries when both URLs are the same one of these two pages, so other pages (and the other of the
 * two) never inherit them.
 */
export function carryBulkTradesParams(projectedQs: string, currentSearch: string | URLSearchParams): string {
  const current = typeof currentSearch === "string" ? new URLSearchParams(currentSearch) : currentSearch;
  const next = new URLSearchParams(projectedQs);
  const page = next.get("path");
  if (!page || !PAGES.includes(page) || current.get("path") !== page) return projectedQs;
  for (const key of BULK_TRADES_PARAMS) {
    const value = current.get(key);
    if (value && !next.has(key)) next.set(key, value);
  }
  return next.toString();
}
