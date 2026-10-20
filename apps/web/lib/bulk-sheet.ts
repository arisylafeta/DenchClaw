// The Bulk Trades sheet: one row per distinct piece of commercial work. Safe for client and server.
//
// A row is a source record (open demand, an open supplier offer, or a live trade), never a merge of
// several. A match between records is a link shown in the detail, not a reason to combine rows.
// Missing values stay null: nothing here is guessed, and progress is only what the record states.

import type { TradeStage } from "./bulk-trades";
import type { BulkTradesRoute } from "./bulk-trades-url";
import { demandTitle } from "./bulk-demand-header";
import type { BuyerContext } from "./buyer-context";

export type SheetKind = "demand" | "supply" | "trade";
/** Starting point: a buyer asking for something, or a seller offering it. A buyer-seller connection is shown in progress and details, not here. */
export type SheetSide = "buyer" | "seller";
export type SheetTone = "new" | "active" | "waiting" | "closing" | "hold";

export type SheetRow = {
  /** `${kind}:${id}`: unique across kinds because ids are only unique per table. */
  key: string;
  kind: SheetKind;
  id: string;
  /** Where the work started: a buyer's need (Buying) or a seller's stock (Selling). */
  side: SheetSide;
  title: string;
  company: string | null;
  company_id: string | null;
  /** Product family or trade kind, as recorded. */
  category: string | null;
  progress: string;
  tone: SheetTone;
  /** Demand score 0-100; null when not scored or not a demand row. */
  score: number | null;
  /** The most recent recorded development, if any. `label` is what happened; `at` is its date. */
  latest: { label: string; at: string | null; kind?: string } | null;
  next_action: string | null;
  next_due: string | null;
  owner: string | null;
  /** Date used to order the sheet, newest first. */
  touched: string | null;
};

export type SheetFilters = {
  query: string;
  side: SheetSide | "all";
  progress: string;
  company: string;
  category: string;
};

export const NO_FILTERS: SheetFilters = { query: "", side: "all", progress: "all", company: "all", category: "all" };

export const SIDE_LABEL: Record<SheetSide, string> = { buyer: "Buying", seller: "Selling" };

const text = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

type DemandInput = {
  id: string; buyer: string; company_id: string | null; wants: string; product_family: string | null; context: BuyerContext;
  activity_count: number; linked_trades: number; latest_kind: string | null; latest_title: string | null;
  latest_at: string | null; asked_on: string | null; updated_at: string; score: number | null;
};

const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note", research: "Research", outreach: "Outreach", call: "Call", quote: "Quote", supply: "Supply", status: "Status",
};

export function demandRow(input: DemandInput): SheetRow {
  const worked = input.activity_count > 0;
  return {
    key: `demand:${input.id}`, kind: "demand", id: input.id, side: "buyer",
    // Same title the demand detail header shows: a curated listing_title if one is set, else derived from wants.
    title: demandTitle({ wants: input.wants, product_family: input.product_family, buyer: input.buyer, context: input.context }),
    company: text(input.buyer), company_id: input.company_id,
    category: text(input.product_family),
    progress: input.linked_trades > 0 ? "On a trade" : worked ? "Being worked" : "New",
    tone: input.linked_trades > 0 ? "closing" : worked ? "active" : "new",
    score: input.score,
    latest: input.latest_title
      ? { label: input.latest_title, at: input.latest_at, kind: ACTIVITY_LABEL[input.latest_kind ?? ""] ?? "Activity" }
      : null,
    next_action: null, next_due: null, owner: null,
    touched: input.latest_at ?? input.asked_on ?? input.updated_at,
  };
}

type SupplyInput = {
  id: string; seller: string; company_id: string | null; offers: string; trade_kind: string | null;
  source_kind: string | null; source_label: string | null; observed_on: string | null; updated_at: string;
};

export function supplyRow(input: SupplyInput): SheetRow {
  const via = input.source_kind === "email" ? "Offer by email" : input.source_kind === "call" ? "Offer on a call" : "Offer received";
  return {
    key: `supply:${input.id}`, kind: "supply", id: input.id, side: "seller",
    title: input.offers, company: text(input.seller), company_id: input.company_id,
    category: text(input.trade_kind), progress: "Offered", tone: "new", score: null,
    latest: { label: via, at: input.observed_on },
    next_action: null, next_due: null, owner: null, touched: input.observed_on ?? input.updated_at,
  };
}

type TradeInput = {
  id: string; title: string; origin: "supply" | "demand"; seller_name: string | null; has_seller: boolean; has_buyer: boolean;
  trade_stage: TradeStage; trade_kind: string | null; next_step: string | null; next_step_due: string | null;
  waiting_on: "us" | "them"; waiting_since: string | null; owner_name: string | null; last_touched: string | null;
  hold_until: string | null; updated_at: string;
};

const TRADE_TONE: Partial<Record<TradeStage, SheetTone>> = {
  "Needs info": "new", "With buyers": "active", Closing: "closing", "On hold": "hold",
};

export function tradeRow(input: TradeInput): SheetRow {
  const latest = input.waiting_since
    ? { label: input.waiting_on === "them" ? "Waiting on them" : "Waiting on us", at: input.waiting_since }
    : input.last_touched ? { label: "Last touched", at: input.last_touched } : null;
  return {
    key: `trade:${input.id}`, kind: "trade", id: input.id,
    side: input.origin === "demand" ? "buyer" : "seller",
    title: input.title, company: text(input.seller_name), company_id: null,
    category: text(input.trade_kind),
    progress: input.trade_stage, tone: TRADE_TONE[input.trade_stage] ?? "active", score: null,
    latest, next_action: text(input.next_step), next_due: input.next_step_due, owner: text(input.owner_name),
    touched: input.last_touched ?? input.updated_at,
  };
}

/** Newest development first; rows with no date last. */
export function sortSheet(rows: SheetRow[]): SheetRow[] {
  return [...rows].sort((a, b) => (b.touched ?? "").localeCompare(a.touched ?? "") || a.title.localeCompare(b.title));
}

export function filterSheet(rows: SheetRow[], filters: SheetFilters): SheetRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) =>
    (filters.side === "all" || row.side === filters.side) &&
    (filters.progress === "all" || row.progress === filters.progress) &&
    (filters.company === "all" || row.company === filters.company) &&
    (filters.category === "all" || row.category === filters.category) &&
    (!needle || [row.title, row.company, row.category, row.progress, row.latest?.label, row.next_action, row.owner]
      .some((value) => value?.toLowerCase().includes(needle))));
}

/** Distinct values present in the rows, for the filter menus. */
export function sheetOptions(rows: SheetRow[]) {
  const distinct = (pick: (row: SheetRow) => string | null) =>
    [...new Set(rows.map(pick).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
  return { progress: distinct((row) => row.progress), company: distinct((row) => row.company), category: distinct((row) => row.category) };
}

const SIDES: readonly string[] = ["buyer", "seller"];

/** The sheet filters a URL asks for. Older tab=demand / tab=supply links mean buyer-led / seller-led. */
export function filtersFromRoute(route: Pick<BulkTradesRoute, "query" | "side" | "progress" | "company" | "category" | "tab">): SheetFilters {
  const legacySide = route.tab === "demand" ? "buyer" : route.tab === "supply" ? "seller" : null;
  const side = route.side ?? legacySide;
  return {
    query: route.query ?? "",
    side: side && SIDES.includes(side) ? (side as SheetSide) : "all",
    progress: route.progress ?? "all",
    company: route.company ?? "all",
    category: route.category ?? "all",
  };
}

/** The URL fields for a set of filters; defaults are left out so shared links stay short. */
export function routeFromFilters(filters: SheetFilters): Partial<BulkTradesRoute> {
  return {
    // Kept as typed: trimming here would eat the space between words while they are being typed.
    query: filters.query.trim() ? filters.query : null,
    side: filters.side === "all" ? null : filters.side,
    progress: filters.progress === "all" ? null : filters.progress,
    company: filters.company === "all" ? null : filters.company,
    category: filters.category === "all" ? null : filters.category,
  };
}
