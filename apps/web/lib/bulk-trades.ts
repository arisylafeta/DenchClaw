// Bulk Trades v3: shared types, validation and list grouping. Safe for client and server.

export const TRADE_STAGES = ["Needs info", "With buyers", "Closing", "Done", "Lost"] as const;
export const LIVE_STAGES = ["Needs info", "With buyers", "Closing"] as const;
export const TRADE_KINDS = ["packs", "cells", "systems", "recycling"] as const;
export const WAITING_ON = ["us", "them"] as const;
export const TFS_NEEDED = ["yes", "no", "unknown"] as const;

export type TradeStage = (typeof TRADE_STAGES)[number];
export type TradeKind = (typeof TRADE_KINDS)[number];

export type BulkTrade = {
  id: string;
  title: string;
  trade_stage: TradeStage;
  trade_kind: TradeKind | null;
  fact_line: string | null;
  next_step: string | null;
  next_step_due: string | null;
  waiting_on: "us" | "them";
  waiting_since: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  value: string | null;
  last_touched: string | null;
  clear_by: string | null;
  ship_by: string | null;
  transport_class: string | null;
  tfs_needed: "yes" | "no" | "unknown";
  updated_at: string;
};

export type TradeOwner = { id: string; name: string };

export type TradePatch = Partial<Pick<BulkTrade,
  | "title" | "trade_stage" | "trade_kind" | "fact_line" | "next_step" | "next_step_due"
  | "waiting_on" | "owner_user_id" | "value" | "last_touched" | "clear_by" | "ship_by"
  | "transport_class" | "tfs_needed"
>>;

const TEXT_FIELDS = ["title", "fact_line", "next_step", "value", "transport_class"] as const;
const DATE_FIELDS = ["next_step_due", "last_touched", "clear_by", "ship_by"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Validates a request body into a patch. Empty strings clear optional fields. */
export function parseTradePatch(body: unknown): { patch: TradePatch } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const input = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    const value = input[key];
    if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      if (value !== null && typeof value !== "string") return { error: `${key} must be text.` };
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (key === "title" && !trimmed) return { error: "title is required." };
      patch[key] = trimmed || null;
    } else if ((DATE_FIELDS as readonly string[]).includes(key)) {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "string" && isValidDate(value)) patch[key] = value;
      else return { error: `${key} must be a YYYY-MM-DD date.` };
    } else if (key === "trade_stage") {
      if (!oneOf(TRADE_STAGES, value)) return { error: "Unknown stage." };
      patch[key] = value;
    } else if (key === "trade_kind") {
      if (value === null || value === "") patch[key] = null;
      else if (oneOf(TRADE_KINDS, value)) patch[key] = value;
      else return { error: "Unknown trade kind." };
    } else if (key === "waiting_on") {
      if (!oneOf(WAITING_ON, value)) return { error: "waiting_on must be us or them." };
      patch[key] = value;
    } else if (key === "tfs_needed") {
      if (!oneOf(TFS_NEEDED, value)) return { error: "tfs_needed must be yes, no or unknown." };
      patch[key] = value;
    } else if (key === "owner_user_id") {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "string" && UUID.test(value)) patch[key] = value;
      else return { error: "owner_user_id must be a user id." };
    } else {
      return { error: `Unknown field: ${key}` };
    }
  }
  return { patch: patch as TradePatch };
}

/** Today's date in the UK, as YYYY-MM-DD. */
export function todayInLondon(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(now);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Fixed names: newer ICU versions print "Sept" for en-GB.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

export type TradeGroupName = "Overdue" | "Due today" | "No next step" | "Waiting on them" | "Later";
export const TRADE_GROUPS: TradeGroupName[] = ["Overdue", "Due today", "No next step", "Waiting on them", "Later"];

export function tradeGroup(trade: BulkTrade, today: string): TradeGroupName {
  const due = trade.next_step_due;
  if (due && due < today && (trade.next_step || trade.waiting_on === "them")) return "Overdue";
  if (trade.waiting_on === "them") return "Waiting on them";
  if (!trade.next_step || !due) return "No next step";
  return due === today ? "Due today" : "Later";
}

/** Live trades grouped in list order. Each group is sorted with the most pressing first. */
export function groupTrades(trades: BulkTrade[], today: string) {
  const live = trades.filter((trade) => (LIVE_STAGES as readonly string[]).includes(trade.trade_stage));
  const groups = new Map<TradeGroupName, BulkTrade[]>(TRADE_GROUPS.map((name) => [name, []]));
  for (const trade of live) groups.get(tradeGroup(trade, today))!.push(trade);

  const byDate = (key: keyof BulkTrade) => (a: BulkTrade, b: BulkTrade) =>
    String(a[key] ?? "9999").localeCompare(String(b[key] ?? "9999")) || a.title.localeCompare(b.title);
  groups.get("Overdue")!.sort(byDate("next_step_due"));
  groups.get("Due today")!.sort((a, b) => a.title.localeCompare(b.title));
  groups.get("No next step")!.sort(byDate("last_touched"));
  groups.get("Waiting on them")!.sort(byDate("waiting_since"));
  groups.get("Later")!.sort(byDate("next_step_due"));

  return TRADE_GROUPS.map((name) => ({ name, trades: groups.get(name)! })).filter((group) => group.trades.length);
}

/** "3d late", "Today", "2 Oct", "since 22 Sep" or "No date". */
export function dueLabel(trade: BulkTrade, today: string): string {
  const due = trade.next_step_due;
  if (due && due < today) return `${daysBetween(due, today)}d late`;
  if (trade.waiting_on === "them") return trade.waiting_since ? `since ${dayMonth(trade.waiting_since)}` : "Waiting";
  if (!due) return trade.next_step ? "No date" : "None";
  return due === today ? "Today" : dayMonth(due);
}

/** "Today", "5d" or "" when never touched. */
export function touchedLabel(trade: BulkTrade, today: string): string {
  if (!trade.last_touched) return "";
  const days = daysBetween(trade.last_touched, today);
  return days <= 0 ? "Today" : `${days}d`;
}

const MONEY = /^([€$£])(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?k$/;

function formatK(amount: number): string {
  return String(Math.round(amount * 10) / 10);
}

/**
 * Column total for the board, e.g. "€395–494k+". Sums values written as "€119–149k" or "$450k"
 * in one currency; "+" means some trades have a value that could not be added. Empty when
 * nothing adds up, or currencies are mixed.
 */
export function stageTotal(trades: BulkTrade[]): string {
  let currency: string | null = null;
  let low = 0;
  let high = 0;
  let skipped = false;
  for (const trade of trades) {
    const match = trade.value?.trim().match(MONEY);
    if (!match) {
      skipped = true;
      continue;
    }
    if (currency && currency !== match[1]) return "";
    currency = match[1];
    low += Number(match[2]);
    high += Number(match[3] ?? match[2]);
  }
  if (!currency) return "";
  const range = low === high ? formatK(low) : `${formatK(low)}–${formatK(high)}`;
  return `${currency}${range}k${skipped ? "+" : ""}`;
}
