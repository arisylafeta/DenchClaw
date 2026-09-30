// Dismantlers: shared types, validation, list grouping and labels. Safe for client and server.
import { dayMonth, daysBetween } from "./bulk-trades";

export const STAGES = ["Found", "Contacted", "Onboarding", "Live", "Syncing", "Parked"] as const;
/** The journey, in order. Parked sits beside it. */
export const JOURNEY = ["Found", "Contacted", "Onboarding", "Live", "Syncing"] as const;
/** Stages worked from the list's urgency groups. Found is the backlog; Parked is out of play. */
export const IN_PLAY = ["Contacted", "Onboarding", "Live", "Syncing"] as const;
export const ROUTES = ["eBay", "API", "Other"] as const;

export type Stage = (typeof STAGES)[number];
export type JourneyStage = (typeof JOURNEY)[number];
export type Route = (typeof ROUTES)[number];

export const STAGE_HINT: Record<Stage, string> = {
  Found: "not contacted yet",
  Contacted: "in conversation",
  Onboarding: "said yes, setting up",
  Live: "stock on ReBattery",
  Syncing: "two syncs, 7+ days apart",
  Parked: "not now or not a fit",
};

/** What has to be true to move on from each stage. */
export const TO_REACH_NEXT: Record<JourneyStage, string> = {
  Found: "To reach Contacted: send them a first message.",
  Contacted: "To reach Onboarding: they say yes and a route is agreed.",
  Onboarding: "To reach Live: their first stock is published on ReBattery.",
  Live: "To reach Syncing: two stock syncs at least 7 days apart, with a sold or changed item updated.",
  Syncing: "Fully set up. Keep in touch, and check the syncs keep running.",
};

export const SETUP_KEYS = [
  "setup_account_on",
  "setup_route_on",
  "setup_connected_on",
  "setup_first_stock_on",
  "setup_first_sync_on",
  "setup_second_sync_on",
] as const;
export type SetupKey = (typeof SETUP_KEYS)[number];

/** Setup checklist wording for the dismantler's route. */
export function setupLabels(route: Route | null): Record<SetupKey, string> {
  const connected = route === "API"
    ? "API key issued and used"
    : route === "eBay"
      ? "eBay connected, Fulfillment permission ticked"
      : "Connected: eBay or API";
  return {
    setup_account_on: "ReBattery account made",
    setup_route_on: route ? `Route agreed: ${route}` : "Route agreed",
    setup_connected_on: connected,
    setup_first_stock_on: "First listings published",
    setup_first_sync_on: "First stock sync ran",
    setup_second_sync_on: "Second sync, 7+ days later, with a sold or changed item updated",
  };
}

export type Dismantler = {
  id: string;
  company_id: string;
  name: string;
  stage: Stage;
  stage_since: string;
  parked_from: JourneyStage | null;
  park_reason: string | null;
  revisit_on: string | null;
  next_step: string | null;
  next_step_due: string | null;
  next_step_person_id: string | null;
  next_step_person_name: string | null;
  waiting_on: "us" | "them";
  waiting_since: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  goal: boolean;
  route: Route | null;
  country: string | null;
  ebay_username: string | null;
  ebay_listings: number | null;
  platform_account_id: string | null;
  source: string | null;
  notes: string | null;
  setup_account_on: string | null;
  setup_route_on: string | null;
  setup_connected_on: string | null;
  setup_first_stock_on: string | null;
  setup_first_sync_on: string | null;
  setup_second_sync_on: string | null;
  /** Latest email with someone at the company, in the viewer's mailbox. */
  last_contact: string | null;
  updated_at: string;
};

export type DismantlerPatch = Partial<Pick<Dismantler,
  | "stage" | "park_reason" | "revisit_on" | "next_step" | "next_step_due" | "next_step_person_id"
  | "waiting_on" | "owner_user_id" | "goal" | "route" | "country" | "ebay_username" | "ebay_listings"
  | "platform_account_id" | "source" | "notes" | SetupKey
>>;

const TEXT_FIELDS = ["park_reason", "next_step", "country", "ebay_username", "platform_account_id", "source", "notes"] as const;
const DATE_FIELDS = ["revisit_on", "next_step_due", ...SETUP_KEYS] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** Validates a request body into a patch. Empty strings clear optional fields. */
export function parseDismantlerPatch(body: unknown): { patch: DismantlerPatch } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const input = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if ((TEXT_FIELDS as readonly string[]).includes(key)) {
      if (value !== null && typeof value !== "string") return { error: `${key} must be text.` };
      patch[key] = (typeof value === "string" ? value.trim() : "") || null;
    } else if ((DATE_FIELDS as readonly string[]).includes(key)) {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "string" && isValidDate(value)) patch[key] = value;
      else return { error: `${key} must be a YYYY-MM-DD date.` };
    } else if (key === "stage") {
      if (!oneOf(STAGES, value)) return { error: "Unknown stage." };
      patch[key] = value;
    } else if (key === "route") {
      if (value === null || value === "") patch[key] = null;
      else if (oneOf(ROUTES, value)) patch[key] = value;
      else return { error: "route must be eBay, API or Other." };
    } else if (key === "waiting_on") {
      if (!oneOf(["us", "them"] as const, value)) return { error: "waiting_on must be us or them." };
      patch[key] = value;
    } else if (key === "goal") {
      if (typeof value !== "boolean") return { error: "goal must be true or false." };
      patch[key] = value;
    } else if (key === "ebay_listings") {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "number" && Number.isInteger(value) && value >= 0) patch[key] = value;
      else return { error: "ebay_listings must be a whole number." };
    } else if (key === "owner_user_id") {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "string" && UUID.test(value)) patch[key] = value;
      else return { error: "owner_user_id must be a user id." };
    } else if (key === "next_step_person_id") {
      if (value === null || value === "") patch[key] = null;
      else if (typeof value === "string" && value.length <= 200) patch[key] = value;
      else return { error: "next_step_person_id must be a CRM person." };
    } else {
      return { error: `Unknown field: ${key}` };
    }
  }
  if (patch.stage === "Parked" && !patch.park_reason) return { error: "Say why it is parked." };
  return { patch: patch as DismantlerPatch };
}

/** The stage after this one on the journey, or null at the end and for Parked. */
export function nextStage(stage: Stage): JourneyStage | null {
  const index = (JOURNEY as readonly string[]).indexOf(stage);
  return index >= 0 && index < JOURNEY.length - 1 ? JOURNEY[index + 1] : null;
}

export type GroupName = "Overdue" | "Due today" | "No next step" | "Waiting on them" | "Later";
export const GROUPS: GroupName[] = ["Overdue", "Due today", "No next step", "Waiting on them", "Later"];
export const GROUP_TONE: Record<GroupName, "red" | "amber" | "grey"> = {
  Overdue: "red",
  "Due today": "amber",
  "No next step": "amber",
  "Waiting on them": "grey",
  Later: "grey",
};

export function dismantlerGroup(d: Dismantler, today: string): GroupName {
  const due = d.next_step_due;
  if (due && due < today && (d.next_step || d.waiting_on === "them")) return "Overdue";
  if (d.waiting_on === "them") return "Waiting on them";
  if (!d.next_step || !due) return "No next step";
  return due === today ? "Due today" : "Later";
}

/** Dismantlers in play, grouped in list order, most pressing first. */
export function groupDismantlers(dismantlers: Dismantler[], today: string) {
  const groups = new Map<GroupName, Dismantler[]>(GROUPS.map((name) => [name, []]));
  for (const d of dismantlers) {
    if ((IN_PLAY as readonly string[]).includes(d.stage)) groups.get(dismantlerGroup(d, today))!.push(d);
  }
  const byDate = (key: "next_step_due" | "waiting_since" | "last_contact") => (a: Dismantler, b: Dismantler) =>
    String(a[key] ?? "9999").localeCompare(String(b[key] ?? "9999")) || a.name.localeCompare(b.name);
  groups.get("Overdue")!.sort(byDate("next_step_due"));
  groups.get("Due today")!.sort((a, b) => a.name.localeCompare(b.name));
  groups.get("No next step")!.sort(byDate("last_contact"));
  groups.get("Waiting on them")!.sort(byDate("waiting_since"));
  groups.get("Later")!.sort(byDate("next_step_due"));
  return GROUPS.map((name) => ({ name, dismantlers: groups.get(name)! })).filter((group) => group.dismantlers.length);
}

/** "2 days late", "Today", "2 Oct", "since 24 Sep", "No date" or "None". */
export function dueLabel(d: Dismantler, today: string): string {
  const due = d.next_step_due;
  if (due && due < today) {
    const days = daysBetween(due, today);
    return `${days} ${days === 1 ? "day" : "days"} late`;
  }
  if (d.waiting_on === "them") return d.waiting_since ? `since ${dayMonth(d.waiting_since)}` : "Waiting";
  if (!due) return d.next_step ? "No date" : "None";
  if (due === today) return "Today";
  return daysBetween(today, due) === 1 ? "Tomorrow" : dayMonth(due);
}

/** "Today", "Yesterday", "8 days" or "" when there has been no email. */
export function contactLabel(d: Dismantler, today: string): string {
  if (!d.last_contact) return "";
  const days = daysBetween(d.last_contact, today);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days`;
}

/** Contact goes amber after two weeks and red after four, while a dismantler is in play. */
export function contactTone(d: Dismantler, today: string): "red" | "amber" | "grey" {
  if (!d.last_contact || !(IN_PLAY as readonly string[]).includes(d.stage)) return "grey";
  const days = daysBetween(d.last_contact, today);
  return days > 28 ? "red" : days > 14 ? "amber" : "grey";
}

export function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A working day count ahead: follow-ups skip the weekend. */
export function addWorkingDays(date: string, days: number): string {
  let current = date;
  let left = days;
  while (left > 0) {
    current = addDays(current, 1);
    const weekday = new Date(`${current}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return current;
}

export const OUTREACH_STEP = "Follow up if no reply";
export const OUTREACH_WORKING_DAYS = 4;

/** One import line: "Name, country, eBay seller, battery listings". Only the name is required. */
export type ImportRow = { name: string; country: string | null; ebay_username: string | null; ebay_listings: number | null };

export function parseImport(text: string): { rows: ImportRow[]; errors: string[] } {
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const cells = line.split(/\t|,/).map((cell) => cell.trim());
    const [name, country, seller, listings] = cells;
    if (!name) return void errors.push(`Line ${index + 1}: no name.`);
    if (/^name$/i.test(name)) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return void errors.push(`Line ${index + 1}: ${name} is listed twice.`);
    seen.add(key);
    const count = listings ? Number(listings.replace(/[^\d]/g, "")) : NaN;
    rows.push({
      name,
      country: country || null,
      ebay_username: seller || null,
      ebay_listings: Number.isFinite(count) && listings ? count : null,
    });
  });
  return { rows, errors };
}
