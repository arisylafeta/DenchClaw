// The Bulk Trades sheet: one row per distinct piece of commercial work. Safe for client and server.
//
// A row is a source record (open demand, an open supplier offer, or a live trade), never a merge of
// several. A match between records is a link shown in the detail, not a reason to combine rows.
// Missing values stay null: nothing here is guessed, and progress is only what the record states.

import type { TradeStage } from "./bulk-trades";

export type SheetKind = "demand" | "supply" | "trade";
export type SheetSide = "buyer" | "seller" | "both";
export type SheetTone = "new" | "active" | "waiting" | "closing" | "hold";

export type SheetRow = {
  /** `${kind}:${id}`: unique across kinds because ids are only unique per table. */
  key: string;
  kind: SheetKind;
  id: string;
  /** Where the work started: a buyer's need, a seller's stock, or a trade with both sides identified. */
  side: SheetSide;
  title: string;
  company: string | null;
  company_id: string | null;
  /** Product family or trade kind, as recorded. */
  category: string | null;
  progress: string;
  tone: SheetTone;
  /** The most recent recorded development, if any. `label` is what happened; `at` is its date. */
  latest: { label: string; at: string | null } | null;
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

export const SIDE_LABEL: Record<SheetSide, string> = { buyer: "Buyer-led", seller: "Seller-led", both: "Both sides" };

const text = (value: string | null | undefined) => (value && value.trim() ? value.trim() : null);

type DemandInput = {
  id: string; buyer: string; company_id: string | null; wants: string; product_family: string | null;
  activity_count: number; linked_trades: number; latest_kind: string | null; latest_title: string | null;
  latest_at: string | null; asked_on: string | null; updated_at: string;
};

const ACTIVITY_LABEL: Record<string, string> = {
  note: "Note", research: "Research", outreach: "Outreach", call: "Call", quote: "Quote", supply: "Supply", status: "Status",
};

export function demandRow(input: DemandInput): SheetRow {
  const worked = input.activity_count > 0;
  return {
    key: `demand:${input.id}`, kind: "demand", id: input.id, side: "buyer",
    title: input.wants, company: text(input.buyer), company_id: input.company_id,
    category: text(input.product_family),
    progress: input.linked_trades > 0 ? "On a trade" : worked ? "Being worked" : "New",
    tone: input.linked_trades > 0 ? "closing" : worked ? "active" : "new",
    latest: input.latest_title
      ? { label: `${ACTIVITY_LABEL[input.latest_kind ?? ""] ?? "Activity"}: ${input.latest_title}`, at: input.latest_at }
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
    category: text(input.trade_kind), progress: "Offered", tone: "new",
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
  const both = input.has_seller && input.has_buyer;
  const latest = input.waiting_since
    ? { label: input.waiting_on === "them" ? "Waiting on them" : "Waiting on us", at: input.waiting_since }
    : input.last_touched ? { label: "Last touched", at: input.last_touched } : null;
  return {
    key: `trade:${input.id}`, kind: "trade", id: input.id,
    side: both ? "both" : input.origin === "demand" ? "buyer" : "seller",
    title: input.title, company: text(input.seller_name), company_id: null,
    category: text(input.trade_kind),
    progress: input.trade_stage, tone: TRADE_TONE[input.trade_stage] ?? "active",
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
