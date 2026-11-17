// The Requests and Supply overview: rows grouped by whose move it is. Safe for client and server.
//
// Whose move comes from the listing's waiting_on field: "them" is their move, "us" or nothing is ours
// (nobody has said whose move it is, so someone here has to). A row with a next step dated a week or more
// out, and not overdue, is on track and folds away whatever its move.

import { addDays, dayMonth } from "./next-action-dates";
import type { SheetFilters, SheetRow } from "./bulk-sheet";
import type { ListingStage } from "./bulk-listing";

export type Move = "you" | "them";

/** Whose move a row is: their move only when the listing says we wait on them. */
export function moveOf(row: Pick<SheetRow, "waiting_on">): Move {
  return row.waiting_on === "them" ? "them" : "you";
}

const dueDay = (row: Pick<SheetRow, "next_due">) => row.next_due?.slice(0, 10) || null;

/** Nothing due within the next 7 days (today included) and not overdue. A row with no due date is never on track. */
export function isOnTrack(row: Pick<SheetRow, "next_due">, today: string): boolean {
  const due = dueDay(row);
  return !!due && due >= addDays(today, 7);
}

export function isOverdue(row: Pick<SheetRow, "next_due">, today: string): boolean {
  const due = dueDay(row);
  return !!due && due < today;
}

/** Soonest (most overdue) due date first; no date last; then by company and title so the order is stable. */
function byDue(a: SheetRow, b: SheetRow): number {
  const da = dueDay(a), db = dueDay(b);
  if (!da !== !db) return da ? -1 : 1;
  return (da ?? "").localeCompare(db ?? "") || (a.company ?? "").localeCompare(b.company ?? "") || a.title.localeCompare(b.title);
}

export type OverviewGroups = { you: SheetRow[]; them: SheetRow[]; onTrack: SheetRow[] };

/** Your move (most overdue first, then by due date), their move (by due date), and on track (by due date). */
export function overviewGroups(rows: SheetRow[], today: string, order: (rows: SheetRow[]) => SheetRow[] = (list) => [...list].sort(byDue)): OverviewGroups {
  const groups: OverviewGroups = { you: [], them: [], onTrack: [] };
  for (const row of rows) groups[isOnTrack(row, today) ? "onTrack" : moveOf(row)].push(row);
  return { you: order(groups.you), them: order(groups.them), onTrack: order(groups.onTrack) };
}

/** The strip above the list. `all` lists everything; the others narrow to one group, `over` to your overdue moves. */
export type StripFilter = "all" | "you" | "over" | "them";

export type StripCounts = { you: number; over: number; them: number; all: number; fees_eur: number; active: number };

export function stripCounts(groups: OverviewGroups, today: string): StripCounts {
  const active = [...groups.you, ...groups.them];
  return {
    you: groups.you.length,
    over: groups.you.filter((row) => isOverdue(row, today)).length,
    them: groups.them.length,
    all: active.length + groups.onTrack.length,
    fees_eur: active.reduce((sum, row) => sum + (row.fee_eur ?? 0), 0),
    active: active.length,
  };
}

/** The groups a strip choice shows. On track only shows under `all`. */
export function applyStrip(groups: OverviewGroups, filter: StripFilter, today: string): OverviewGroups {
  switch (filter) {
    case "all": return groups;
    case "you": return { you: groups.you, them: [], onTrack: [] };
    case "over": return { you: groups.you.filter((row) => isOverdue(row, today)), them: [], onTrack: [] };
    case "them": return { you: [], them: groups.them, onTrack: [] };
  }
}

/** Clicking the chosen count again clears it. */
export function nextStrip(current: StripFilter, clicked: StripFilter): StripFilter {
  return current === clicked ? "all" : clicked;
}

/** The six steps of the stage track. */
export const TRACK_STAGES = ["New", "Qualified", "Sourcing", "Offered", "Negotiating", "Agreed"] as const;

/**
 * Where a listing stage sits on the six-step track. Can't source is stuck at Sourcing (3); a supply lot's Available
 * is ready to offer, so also 3. Paid and Delivered are past Agreed: all six steps done, none current.
 */
const STEP: Record<ListingStage, number> = {
  New: 1, Qualified: 2, Sourcing: 3, "Can't source": 3, Available: 3, Offered: 4, Negotiating: 5, Agreed: 6, Paid: 6, Delivered: 6,
};
const PAST_TRACK: readonly string[] = ["Paid", "Delivered"];

export type TrackStep = "done" | "now" | "";

export function stageTrack(stage: string): { step: number; segments: TrackStep[] } {
  const step = STEP[stage as ListingStage] ?? 1;
  const complete = PAST_TRACK.includes(stage);
  return { step, segments: TRACK_STAGES.map((_, index) => (index < step - 1 || (complete && index === step - 1) ? "done" : index === step - 1 ? "now" : "")) };
}

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
/** Whole days from `from` to `to` (both "YYYY-MM-DD"). */
export const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));

export type DueTone = "over" | "today" | "soon";

/** The due chip: "Overdue 3 days", "Due today", "Due tomorrow", "Due 20 Nov". Null with no date. */
export function dueChip(due: string | null | undefined, today: string): { text: string; tone: DueTone } | null {
  const day = due?.slice(0, 10);
  if (!day) return null;
  const days = daysBetween(today, day);
  if (days < 0) return { text: `Overdue ${-days} ${days === -1 ? "day" : "days"}`, tone: "over" };
  if (days === 0) return { text: "Due today", tone: "today" };
  if (days === 1) return { text: "Due tomorrow", tone: "soon" };
  return { text: `Due ${dayMonth(day)}`, tone: "soon" };
}

/** "today", "1 day", "6 days", then whole weeks from two weeks on. */
function age(days: number): string {
  if (days <= 0) return "today";
  if (days < 14) return `${days} ${days === 1 ? "day" : "days"}`;
  return `${Math.floor(days / 7)} weeks`;
}

export const firstName = (contact: string | null | undefined) => contact?.trim().split(/\s+/)[0] || null;

/** "Your move · since 30 Oct" or "Their move · Markus, 6 days". */
export function moveLabel(row: Pick<SheetRow, "waiting_on" | "waiting_since" | "contact">, today: string): string {
  const since = row.waiting_since?.slice(0, 10) || null;
  if (moveOf(row) === "you") return since ? `Your move · since ${dayMonth(since)}` : "Your move";
  const detail = [firstName(row.contact), since ? age(daysBetween(since, today)) : null].filter(Boolean).join(", ");
  return detail ? `Their move · ${detail}` : "Their move";
}

/** How many filters in the Filters popover are on. Search has its own box; a side locked by the tab is not a filter. */
export function activeFilterCount(filters: SheetFilters, sideLocked: boolean): number {
  return [filters.progress !== "all", filters.company !== "all", filters.category !== "all", filters.waiting !== "all", !sideLocked && filters.side !== "all"]
    .filter(Boolean).length;
}
