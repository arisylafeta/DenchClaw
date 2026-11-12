// Bulk Trades Today, the pure part (slice 3): overdue next steps by owner, deals stuck in New, the active deal limit,
// whose move it is on each deal from the real conversation, and team mentions. Safe for client and server.
import { DEAL_OWNERS } from "./bulk-owner";
import { workingDaysBetween } from "./chase-clock";
import type { SheetRow } from "./bulk-sheet";

/** A deal in New for longer than this many days needs a decision: move it on, or remove it with a reason. */
export const STUCK_NEW_DAYS = 7;
/** More active deals than this for one owner is more than can be worked well; Today says so plainly. */
export const ACTIVE_DEAL_LIMIT = 20;
const DAY = 86_400_000;

/** Whole calendar days a New listing has been New, or null when it is not New (or closed). */
export function daysInNew(row: Pick<SheetRow, "progress" | "closed" | "stage_since">, now: Date = new Date()): number | null {
  if (row.closed || row.progress !== "New" || !row.stage_since) return null;
  const since = Date.parse(row.stage_since);
  return Number.isNaN(since) ? null : Math.floor((now.getTime() - since) / DAY);
}

/** Open listings in New for more than STUCK_NEW_DAYS days, longest first. */
export function stuckInNew(rows: SheetRow[], now: Date = new Date()): { row: SheetRow; days: number }[] {
  return rows.flatMap((row) => {
    const days = daysInNew(row, now);
    return days != null && days > STUCK_NEW_DAYS ? [{ row, days }] : [];
  }).sort((a, b) => b.days - a.days || a.row.title.localeCompare(b.row.title));
}

/** Active: open, past New, and not a finished deal (Delivered or Lost). */
export const isActive = (row: SheetRow) => !row.closed && row.progress !== "New" && row.progress !== "Closed" && row.progress !== "Sold"
  && row.deal_stage !== "Delivered" && row.deal_stage !== "Lost";

/** Owners with more than ACTIVE_DEAL_LIMIT active deals ("No owner" counts as one too), most first. */
export function overLimit(rows: SheetRow[]): { owner: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows.filter(isActive)) counts.set(row.owner ?? "No owner", (counts.get(row.owner ?? "No owner") ?? 0) + 1);
  return [...counts].filter(([, count]) => count > ACTIVE_DEAL_LIMIT).map(([owner, count]) => ({ owner, count })).sort((a, b) => b.count - a.count);
}

export type DealWaiting = { on: "them" | "us"; days: number; since: string };

/**
 * Whose move it is, from the last real message on the deal's linked threads and chats (SheetRow.last_in_at / last_out_at /
 * waiting_from), in working days: waiting on them since our first unanswered message, or on us since their newest one.
 * Null when the deal has no linked conversation.
 */
export function dealWaiting(row: Pick<SheetRow, "last_in_at" | "last_out_at" | "waiting_from">, now: Date = new Date()): DealWaiting | null {
  const lastIn = row.last_in_at ? Date.parse(row.last_in_at) : NaN;
  const lastOut = row.last_out_at ? Date.parse(row.last_out_at) : NaN;
  if (Number.isNaN(lastIn) && Number.isNaN(lastOut)) return null;
  if (!Number.isNaN(lastOut) && (Number.isNaN(lastIn) || lastOut > lastIn)) {
    const since = row.waiting_from ?? row.last_out_at!;
    return { on: "them", days: workingDaysBetween(since, now), since };
  }
  return { on: "us", days: workingDaysBetween(row.last_in_at!, now), since: row.last_in_at! };
}

/** "Waiting on them · 3 working days", "Waiting on us · today". */
export function waitingLabel(waiting: DealWaiting): string {
  const when = waiting.days === 0 ? "today" : `${waiting.days} working ${waiting.days === 1 ? "day" : "days"}`;
  return `Waiting on ${waiting.on} · ${when}`;
}

/** Overdue next steps grouped by owner, in the order of DEAL_OWNERS, then "No owner". Each group keeps its order. */
export function overdueByOwner(rows: SheetRow[]): { owner: string; rows: SheetRow[] }[] {
  const order = [...DEAL_OWNERS, "No owner"] as string[];
  const groups = new Map<string, SheetRow[]>();
  for (const row of rows) groups.set(row.owner ?? "No owner", [...(groups.get(row.owner ?? "No owner") ?? []), row]);
  return [...groups].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([owner, list]) => ({ owner, rows: list }));
}

// ---------- team notes and @mentions ----------

/** The three people a note can mention. Matching is by first name after an @, any case: "@sean", "@Alex". */
export function mentionsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(^|[^\w@.])@(\p{L}+)/gu)) {
    const owner = DEAL_OWNERS.find((name) => name.toLowerCase() === match[2].toLowerCase());
    if (owner) found.add(owner);
  }
  return DEAL_OWNERS.filter((name) => found.has(name));
}

/** A mention row on someone's Today: the note, the deal it is on, and whether that person ticked it. */
export type Mention = { id: string; listing_id: string; listing_title: string; text: string; by: string | null; at: string; mentions: string[]; ticked: Record<string, string> };

/** Mentions still open for one person: they are mentioned and have not ticked it. */
export const openMentions = (mentions: Mention[], person: string) => mentions.filter((m) => m.mentions.includes(person) && !m.ticked[person]);
