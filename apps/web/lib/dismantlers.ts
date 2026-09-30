// Dismantlers: shared types, validation, list grouping and labels. Safe for client and server.
import { dayMonth, daysBetween } from "./bulk-trades";

export const STAGES = ["Found", "Talking", "Signed up", "Live", "Parked"] as const;
/** The journey, in order. Parked sits beside it. */
export const JOURNEY = ["Found", "Talking", "Signed up", "Live"] as const;
/** Stages worked from the list. Found is the backlog; Parked is out of play. */
export const IN_PLAY = ["Talking", "Signed up", "Live"] as const;

export type Stage = (typeof STAGES)[number];
export type JourneyStage = (typeof JOURNEY)[number];

export const STAGE_HINT: Record<Stage, string> = {
  Found: "not contacted yet",
  Talking: "in touch with us",
  "Signed up": "has a ReBattery account",
  Live: "batteries listed on ReBattery",
  Parked: "not now or not a fit",
};

/** What has to be true to move on from each stage. */
export const TO_REACH_NEXT: Record<JourneyStage, string> = {
  Found: "To reach Talking: send them a first message.",
  Talking: "To reach Signed up: they make a ReBattery account. Once it is linked, they move by themselves.",
  "Signed up": "To reach Live: they list their first battery on ReBattery. They move by themselves when they do.",
  Live: "Live. Keep their stock coming, and check in if listings stop.",
};

/** What ReBattery shows for the dismantler's supplier account. */
export type PlatformFacts = {
  account_id: string;
  account_name: string;
  /** How the account was found: set by hand, a shared email, or the company's web domain. */
  matched_by: "linked" | "email" | "domain";
  signed_up_on: string;
  /** Listings published now. */
  listed: number;
  /** Listings ever published, including ones since sold or withdrawn. Drafts do not count. */
  listed_ever: number;
  /** Completed sales. */
  sold: number;
  first_listed_on: string | null;
  last_listed_on: string | null;
};

export type Dismantler = {
  id: string;
  company_id: string;
  name: string;
  /** The stage shown: the saved stage, lifted to Signed up or Live when ReBattery shows it. */
  stage: Stage;
  /** The stage as saved by hand. */
  saved_stage: Stage;
  stage_since: string;
  parked_from: JourneyStage | null;
  park_reason: string | null;
  revisit_on: string | null;
  next_step: string | null;
  next_step_due: string | null;
  next_step_person_id: string | null;
  next_step_person_name: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  goal: boolean;
  country: string | null;
  ebay_username: string | null;
  ebay_listings: number | null;
  /** Set by hand: an account id, "none", or null to match automatically. */
  platform_account_id: string | null;
  platform: PlatformFacts | null;
  source: string | null;
  notes: string | null;
  /** Latest email or meeting with anyone at the company, from the CRM sync. Shared by everyone. */
  last_contact: string | null;
  updated_at: string;
};

export type DismantlerPatch = Partial<Pick<Dismantler,
  | "stage" | "park_reason" | "revisit_on" | "next_step" | "next_step_due" | "next_step_person_id"
  | "owner_user_id" | "goal" | "country" | "ebay_username" | "ebay_listings"
  | "platform_account_id" | "source" | "notes"
>>;

const TEXT_FIELDS = ["park_reason", "next_step", "country", "ebay_username", "platform_account_id", "source", "notes"] as const;
const DATE_FIELDS = ["revisit_on", "next_step_due"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RANK: Record<Stage, number> = { Parked: -1, Found: 0, Talking: 1, "Signed up": 2, Live: 3 };

/** What ReBattery proves: an account means Signed up, any listing ever means Live. */
export function platformStage(platform: PlatformFacts | null): Stage | null {
  if (!platform) return null;
  return platform.listed_ever > 0 || platform.sold > 0 ? "Live" : "Signed up";
}

/** The saved stage, lifted by what ReBattery proves. Facts win over Parked too. */
export function effectiveStage(saved: Stage, platform: PlatformFacts | null): Stage {
  const proven = platformStage(platform);
  return proven && RANK[proven] > RANK[saved] ? proven : saved;
}

/** When a lifted stage began, by ReBattery's dates: first listing for Live, account for Signed up. */
export function platformStageSince(stage: Stage, platform: PlatformFacts): string {
  return (stage === "Live" ? platform.first_listed_on : null) ?? platform.signed_up_on;
}

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

export type GroupName = "Overdue" | "Due today" | "No next step" | "This week" | "Later";
export const GROUPS: GroupName[] = ["Overdue", "Due today", "No next step", "This week", "Later"];
export const GROUP_TONE: Record<GroupName, "red" | "amber" | "grey"> = {
  Overdue: "red",
  "Due today": "amber",
  "No next step": "amber",
  "This week": "grey",
  Later: "grey",
};

export function dismantlerGroup(d: Pick<Dismantler, "next_step" | "next_step_due">, today: string): GroupName {
  const due = d.next_step_due;
  if (!d.next_step || !due) return "No next step";
  if (due < today) return "Overdue";
  if (due === today) return "Due today";
  return daysBetween(today, due) <= 7 ? "This week" : "Later";
}

const inPlay = (d: Pick<Dismantler, "stage">) => (IN_PLAY as readonly string[]).includes(d.stage);

/** Dismantlers in play, grouped in list order, most pressing first. Q4 goal ones lead each group. */
export function groupDismantlers(dismantlers: Dismantler[], today: string) {
  const groups = new Map<GroupName, Dismantler[]>(GROUPS.map((name) => [name, []]));
  for (const d of dismantlers) if (inPlay(d)) groups.get(dismantlerGroup(d, today))!.push(d);
  const order = (a: Dismantler, b: Dismantler) =>
    Number(b.goal) - Number(a.goal)
    || String(a.next_step_due ?? a.last_contact ?? "9999").localeCompare(String(b.next_step_due ?? b.last_contact ?? "9999"))
    || a.name.localeCompare(b.name);
  return GROUPS.map((name) => ({ name, dismantlers: groups.get(name)!.sort(order) })).filter((group) => group.dismantlers.length);
}

/** The numbers the tab exists to move. */
export function summarise(dismantlers: Dismantler[], today: string) {
  const live = dismantlers.filter((d) => d.stage === "Live");
  const goal = dismantlers.filter((d) => d.goal);
  return {
    live: live.length,
    goal: goal.length,
    goalLive: goal.filter((d) => d.stage === "Live").length,
    listed: dismantlers.reduce((sum, d) => sum + (d.platform?.listed ?? 0), 0),
    sold: dismantlers.reduce((sum, d) => sum + (d.platform?.sold ?? 0), 0),
    due: dismantlers.filter((d) => inPlay(d) && ["Overdue", "Due today", "This week"].includes(dismantlerGroup(d, today))).length,
  };
}

/** "2 days late", "Today", "Tomorrow", "2 Oct", "No date" or "None". */
export function dueLabel(d: Pick<Dismantler, "next_step" | "next_step_due">, today: string): string {
  const due = d.next_step_due;
  if (!d.next_step) return "None";
  if (!due) return "No date";
  if (due < today) {
    const days = daysBetween(due, today);
    return `${days} ${days === 1 ? "day" : "days"} late`;
  }
  if (due === today) return "Today";
  return daysBetween(today, due) === 1 ? "Tomorrow" : dayMonth(due);
}

/** "Today", "Yesterday", "8 days" or "" when there has been no email. */
export function contactLabel(d: Pick<Dismantler, "last_contact">, today: string): string {
  if (!d.last_contact) return "";
  const days = daysBetween(d.last_contact, today);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days`;
}

/** Contact goes amber after two weeks and red after four, while a dismantler is in play. */
export function contactTone(d: Pick<Dismantler, "last_contact" | "stage">, today: string): "red" | "amber" | "grey" {
  if (!d.last_contact || !inPlay(d)) return "grey";
  const days = daysBetween(d.last_contact, today);
  return days > 28 ? "red" : days > 14 ? "amber" : "grey";
}

/** "14 listed · 3 sold", "Signed up, nothing listed yet", or "" with no account. */
export function platformLabel(platform: PlatformFacts | null): string {
  if (!platform) return "";
  if (!platform.listed_ever && !platform.sold) return "Signed up, nothing listed yet";
  return [`${platform.listed} listed`, platform.sold ? `${platform.sold} sold` : null].filter(Boolean).join(" · ");
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
    // A spreadsheet paste is tab-separated, so commas inside names survive; typed lines use commas.
    const cells = line.split(line.includes("\t") ? "\t" : ",").map((cell) => cell.trim());
    const [name, country, seller, listings] = cells;
    if (!name) return void errors.push(`Line ${index + 1}: no name.`);
    if (/^name$/i.test(name)) return;
    if (cells.length > 4) return void errors.push(`Line ${index + 1}: more than 4 columns. Put names with commas in a spreadsheet, or leave the comma out.`);
    if (listings && !/^\d[\d,]*$/.test(listings)) return void errors.push(`Line ${index + 1}: battery listings must be a number.`);
    const key = name.toLowerCase();
    if (seen.has(key)) return void errors.push(`Line ${index + 1}: ${name} is listed twice.`);
    seen.add(key);
    rows.push({
      name,
      country: country || null,
      ebay_username: seller || null,
      ebay_listings: listings ? Number(listings.replace(/,/g, "")) : null,
    });
  });
  return { rows, errors };
}
