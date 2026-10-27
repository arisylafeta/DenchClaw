// The Bulk Trades sheet: one row per distinct piece of commercial work. Safe for client and server.
//
// A row is a source record (open demand, an open supplier offer, or a live trade), never a merge of
// several. A match between records is a link shown in the detail, not a reason to combine rows.
// Missing values stay null: nothing here is guessed, and progress is only what the record states.

import { dealOwner } from "./bulk-owner";
import { likelihoodOf } from "./bulk-likelihood";
import { LISTING_STAGES, TRADE_STAGES, type ListingStage } from "./bulk-listing";
import type { OfferStage } from "./crm-postgres/bulk-offers";
import type { BulkTradesRoute } from "./bulk-trades-url";
import { demandTitle } from "./bulk-demand-header";
import type { BuyerContext } from "./buyer-context";

export type WaitingOn = "us" | "them";
export const WAITING_LABEL: Record<WaitingOn, string> = { us: "On us", them: "Waiting on them" };

/** The commission the founders quote sellers: a fixed share of the deal value. */
export const FEE_RATE = 0.1;

export type SheetKind = "demand" | "supply";
/** Starting point: a buyer asking for something, or a seller offering it. A buyer-seller connection is shown in progress and details, not here. */
export type SheetSide = "buyer" | "seller";
/** Stage colour. `warning` reads as a problem (Can't source); `hold` is a paused listing. */
export type SheetTone = "new" | "active" | "waiting" | "closing" | "hold" | "warning";

export type SheetRow = {
  /** The listing id, unique across demand and supply. */
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
  /** The listing stage, one of LISTING_STAGES. */
  progress: ListingStage;
  /** On hold: a tag on the stage, not a stage of its own. */
  held?: boolean;
  is_trade?: boolean;
  tone: SheetTone;
  /** Score 0-100: demand by expected fee, supply by value of all stock; null when not scored. */
  score: number | null;
  /** Approximate deal value in EUR: supply is the value of all stock, demand is the fee divided by FEE_RATE. Null when unknown. */
  value_eur?: number | null;
  /** Chance (0-100 %) the deal completes, set per deal. Null when not set. */
  likelihood?: number | null;
  /** Our fee in EUR: the fee set on the listing (context.fee_eur), else FEE_RATE of the value. Null when neither is known. */
  fee_eur?: number | null;
  /** True when the fee was set by hand rather than taken as FEE_RATE of the value. */
  fee_is_override?: boolean;
  /** The most recent recorded development, if any. `label` is what happened; `at` is its date. */
  latest: { label: string; at: string | null; kind?: string } | null;
  next_action: string | null;
  next_due: string | null;
  /** Whose move it is: us (we owe the step, or they spoke last) or them (we spoke last). Null when not judged. */
  waiting_on?: WaitingOn | null;
  waiting_since?: string | null;
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
  /** Whose move it is; "us" lists what we still owe a follow-up on. */
  waiting: WaitingOn | "all";
};

export const NO_FILTERS: SheetFilters = { query: "", side: "all", progress: "all", company: "all", category: "all", waiting: "all" };

export const SIDE_LABEL: Record<SheetSide, string> = { buyer: "Buying", seller: "Selling" };

const text = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note", research: "Research", outreach: "Outreach", call: "Call", quote: "Quote", supply: "Supply", status: "Status",
};

/** Every Preview row is a bulk listing. */
export type ListingSheetInput = {
  id: string; kind: SheetKind; party: string; company_id: string | null;
  summary: string; spec: Record<string, unknown>; context: BuyerContext;
  status: string; score: number | null; activity_count: number;
  latest_kind: string | null; latest_title: string | null; latest_at: string | null;
  observed_on: string | null; updated_at: string; next_action: string | null; next_due: string | null;
  waiting_on?: string | null; waiting_since?: string | null;
  furthest_stage: string | null;
  /** From bulk_listing_stage(): one of LISTING_STAGES. */
  stage: ListingStage;
};

const positive = (value: unknown): number | null => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

/** A fee set by hand on a listing (context.fee_eur), in whole EUR. Zero is a real answer (no fee); anything else unusable is null. */
export function feeOverrideOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Approximate value and fee. Supply carries the value of all stock; demand carries the fee (set as FEE_RATE of
 * volume x ceiling price, or of a matched lot), so its value is derived back from it. The fee is the one set on the
 * listing (context.fee_eur) when there is one, else FEE_RATE of the value. */
export function valueAndFee(kind: SheetKind, spec: Record<string, unknown>, context?: Record<string, unknown> | null): { value_eur: number | null; fee_eur: number | null; fee_is_override: boolean } {
  const value = kind === "supply" ? positive(spec.value_eur) : (() => { const fee = positive(spec.fee_eur); return fee === null ? null : Math.round(fee / FEE_RATE); })();
  const override = feeOverrideOf(context?.fee_eur);
  if (override !== null) return { value_eur: value, fee_eur: override, fee_is_override: true };
  return { value_eur: value, fee_eur: value === null ? null : Math.round(value * FEE_RATE), fee_is_override: false };
}

/** Compact euro amount for the sheet, e.g. €850, €12.9k, €3.5M. */
export function formatEurCompact(value: number | null | undefined): string {
  if (value == null) return "—";
  if (value < 1000) return `€${Math.round(value)}`;
  if (value < 1_000_000) return `€${(value / 1000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `€${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}

export const STAGE_TONE: Record<ListingStage, SheetTone> = {
  New: "new", Qualified: "new", Sourcing: "active", Found: "active", Available: "active", "Can't source": "warning",
  Offered: "waiting", Negotiating: "waiting", Agreed: "closing", Paid: "closing", Delivered: "closing",
};

export function listingRow(input: ListingSheetInput): SheetRow {
  const specText = (key: string) => typeof input.spec[key] === "string" ? input.spec[key] as string : null;
  const ctxText = (key: string) => { const value = (input.context as Record<string, unknown> | null)?.[key]; return typeof value === "string" ? value : null; };
  const category = specText("product_family") ?? specText("trade_kind");
  const hold = specText("trade_stage") === "On hold" || !!specText("hold_until");
  return {
    key: input.id, id: input.id, kind: input.kind,
    side: input.kind === "demand" ? "buyer" : "seller",
    title: input.kind === "demand"
      ? demandTitle({ wants: input.summary, product_family: category, buyer: input.party, context: input.context })
      : text(ctxText("listing_title")) ?? text(specText("listing_title")) ?? text(specText("title")) ?? input.summary,
    company: text(input.party), company_id: input.company_id, category,
    is_trade: TRADE_STAGES.includes(input.furthest_stage as OfferStage),
    progress: input.stage, held: hold,
    tone: hold ? "hold" : STAGE_TONE[input.stage],
    score: input.score,
    ...valueAndFee(input.kind, input.spec, input.context as Record<string, unknown> | null),
    latest: input.latest_title ? { label: input.latest_title, at: input.latest_at, kind: ACTIVITY_LABEL[input.latest_kind ?? ""] ?? "Activity" } : null,
    next_action: text(input.next_action), likelihood: likelihoodOf((input.context as Record<string, unknown> | null)?.likelihood), next_due: input.next_due, owner: dealOwner((input.context as Record<string, unknown> | null)?.owner),
    waiting_on: input.waiting_on === "us" || input.waiting_on === "them" ? input.waiting_on : null, waiting_since: input.waiting_since ?? null,
    touched: input.latest_at ?? input.observed_on ?? input.updated_at,
  };
}

/** Newest development first; rows with no date last. */
export function sortSheet(rows: SheetRow[]): SheetRow[] {
  return [...rows].sort((a, b) => (b.touched ?? "").localeCompare(a.touched ?? "") || a.title.localeCompare(b.title));
}

/** Within one side the sheet is a ranking: best score first, unscored last, then newest. Demand and supply
 * scores measure different things, so a mixed view keeps the newest-first order. */
function rankSide(rows: SheetRow[], side: SheetFilters["side"]): SheetRow[] {
  if (side === "all") return rows;
  return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/** How the list is ordered. `newest` keeps the default order from filterSheet. */
export const SHEET_SORTS = ["newest", "score_desc", "score_asc", "due", "stage", "fee_desc"] as const;
export type SheetSort = (typeof SHEET_SORTS)[number];
export const SORT_LABEL: Record<SheetSort, string> = {
  newest: "Newest first", score_desc: "Score: high to low", score_asc: "Score: low to high", due: "Next due: soonest", stage: "Stage: furthest first", fee_desc: "Fee: high to low",
};

/** Orders already-filtered rows. Unscored rows and rows with no due date sort last in every score or date order, so they never crowd the top. */
export function sortRows(rows: SheetRow[], sort: SheetSort): SheetRow[] {
  if (sort === "newest") return rows;
  const byTitle = (a: SheetRow, b: SheetRow) => a.title.localeCompare(b.title);
  const scoreDesc = (a: SheetRow, b: SheetRow) => (b.score ?? -1) - (a.score ?? -1);
  const out = [...rows];
  switch (sort) {
    case "score_desc": return out.sort((a, b) => scoreDesc(a, b) || byTitle(a, b));
    case "score_asc": return out.sort((a, b) => (a.score === null) !== (b.score === null) ? (a.score === null ? 1 : -1) : (a.score ?? 0) - (b.score ?? 0) || byTitle(a, b));
    case "due": return out.sort((a, b) => (a.next_due === null) !== (b.next_due === null) ? (a.next_due === null ? 1 : -1) : (a.next_due ?? "").localeCompare(b.next_due ?? "") || scoreDesc(a, b));
    case "fee_desc": return out.sort((a, b) => (b.fee_eur ?? -1) - (a.fee_eur ?? -1) || scoreDesc(a, b) || byTitle(a, b));
    case "stage": return out.sort((a, b) => LISTING_STAGES.indexOf(b.progress) - LISTING_STAGES.indexOf(a.progress) || scoreDesc(a, b) || byTitle(a, b));
  }
}

export function filterSheet(rows: SheetRow[], filters: SheetFilters): SheetRow[] {
  const needle = filters.query.trim().toLowerCase();
  return rankSide(rows.filter((row) =>
    (filters.side === "all" || row.side === filters.side) &&
    (filters.progress === "all" || row.progress === filters.progress) &&
    (filters.company === "all" || row.company === filters.company) &&
    (filters.category === "all" || row.category === filters.category) &&
    (filters.waiting === "all" || row.waiting_on === filters.waiting) &&
    (!needle || [row.title, row.company, row.category, row.progress, row.latest?.label, row.next_action, row.owner]
      .some((value) => value?.toLowerCase().includes(needle)))), filters.side);
}

/** Distinct values present in the rows, for the filter menus. */
export function sheetOptions(rows: SheetRow[]) {
  const distinct = (pick: (row: SheetRow) => string | null) =>
    [...new Set(rows.map(pick).filter((value): value is string => !!value))].sort((a, b) => a.localeCompare(b));
  return { progress: distinct((row) => row.progress).sort((a, b) => LISTING_STAGES.indexOf(a as ListingStage) - LISTING_STAGES.indexOf(b as ListingStage)), company: distinct((row) => row.company), category: distinct((row) => row.category) };
}

const SIDES: readonly string[] = ["buyer", "seller"];

/** The sheet filters a URL asks for. Older tab=demand / tab=supply links mean buyer-led / seller-led. */
export function filtersFromRoute(route: Pick<BulkTradesRoute, "query" | "side" | "progress" | "company" | "category" | "tab"> & { waiting?: string | null }): SheetFilters {
  const legacySide = route.tab === "demand" ? "buyer" : route.tab === "supply" ? "seller" : null;
  const side = route.side ?? legacySide;
  return {
    query: route.query ?? "",
    side: side && SIDES.includes(side) ? (side as SheetSide) : "all",
    progress: route.progress ?? "all",
    company: route.company ?? "all",
    category: route.category ?? "all",
    waiting: route.waiting === "us" || route.waiting === "them" ? route.waiting : "all",
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
    waiting: filters.waiting === "all" ? null : filters.waiting,
  };
}
