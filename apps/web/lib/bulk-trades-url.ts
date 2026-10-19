/**
 * Bulk Trades URL model: the one parser and builder for every Bulk Trades link.
 *
 * A Bulk Trades page is `/?path=bulk_trade` plus the params below. The shell owns `path`;
 * this module owns everything else, so shell navigation, chat links and the page agree.
 *
 *   Sheet:      /?path=bulk_trade            (filters: &q=…&side=buyer|seller|both&progress=…&company=…&category=…)
 *   Trade:      /?path=bulk_trade&trade=<id>
 *   Demand:     /?path=bulk_trade&demand=<id>
 *   Supply:     /?path=bulk_trade&supply=<id>
 *
 * Older links with tab=today|trades|demand|supply or status=… still open the sheet; tab=demand and
 * tab=supply map to the buyer-led and seller-led filters. Selected records open as before.
 */

export const BULK_TRADES_PATH = "bulk_trade";

export type BulkTradesTab = "today" | "trades" | "demand" | "supply";

export type BulkTradesRoute = {
  /** Explicit tab from the URL; null lets the page pick the viewer's last tab. */
  tab: BulkTradesTab | null;
  trade: string | null;
  demand: string | null;
  supply: string | null;
  /** Sheet filters. */
  query: string | null;
  side: string | null;
  progress: string | null;
  company: string | null;
  category: string | null;
  /** Legacy list filter, kept so old links parse; the sheet ignores it. */
  status: string | null;
};

const SHELL_PARAMS = ["terminal", "browse", "hidden"] as const;
const TABS: BulkTradesTab[] = ["today", "trades", "demand", "supply"];
export const BULK_TRADES_PARAMS = ["tab", "trade", "demand", "supply", "status", "q", "side", "progress", "company", "category"] as const;

const EMPTY: BulkTradesRoute = { tab: null, trade: null, demand: null, supply: null, status: null, query: null, side: null, progress: null, company: null, category: null };

export function parseBulkTradesRoute(search: string | URLSearchParams): BulkTradesRoute {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const tab = params.get("tab") as BulkTradesTab | null;
  return {
    tab: tab && TABS.includes(tab) ? tab : null,
    trade: params.get("trade") || null,
    demand: params.get("demand") || null,
    supply: params.get("supply") || null,
    status: params.get("status") || null,
    query: params.get("q") || null,
    side: params.get("side") || null,
    progress: params.get("progress") || null,
    company: params.get("company") || null,
    category: params.get("category") || null,
  };
}

/** Build the params for a route (without `path`), omitting empty values. */
export function bulkTradesParams(patch: Partial<BulkTradesRoute>): URLSearchParams {
  const route = { ...EMPTY, ...patch };
  const params = new URLSearchParams();
  if (route.tab) params.set("tab", route.tab);
  if (route.trade) params.set("trade", route.trade);
  if (route.demand) params.set("demand", route.demand);
  if (route.supply) params.set("supply", route.supply);
  if (route.status) params.set("status", route.status);
  if (route.query) params.set("q", route.query);
  if (route.side) params.set("side", route.side);
  if (route.progress) params.set("progress", route.progress);
  if (route.company) params.set("company", route.company);
  if (route.category) params.set("category", route.category);
  return params;
}

/** Shareable link to a Bulk Trades page or record. */
export function buildBulkTradesUrl(patch: Partial<BulkTradesRoute> = {}, current?: URLSearchParams): string {
  const params = new URLSearchParams({ path: BULK_TRADES_PATH });
  // Shell state (terminal, browse folder, hidden files) is not part of the destination; keep it.
  if (current) for (const key of SHELL_PARAMS) if (current.has(key)) params.set(key, current.get(key)!);
  for (const [key, value] of bulkTradesParams(patch)) params.set(key, value);
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

/**
 * Carry the Bulk Trades params from the current URL into a query string the shell projected.
 * The shell does not know these params; without this it drops them on every re-projection.
 * Only carries when both URLs are the Bulk Trades page, so other pages never inherit them.
 */
export function carryBulkTradesParams(projectedQs: string, currentSearch: string | URLSearchParams): string {
  const current = typeof currentSearch === "string" ? new URLSearchParams(currentSearch) : currentSearch;
  const next = new URLSearchParams(projectedQs);
  if (next.get("path") !== BULK_TRADES_PATH || current.get("path") !== BULK_TRADES_PATH) return projectedQs;
  for (const key of BULK_TRADES_PARAMS) {
    const value = current.get(key);
    if (value && !next.has(key)) next.set(key, value);
  }
  return next.toString();
}
