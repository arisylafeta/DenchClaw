// Bulk Trades v3, trade page: buyers, bids, contacts, field data and files. Safe for client and server.

import type { BulkTrade, TradeKind } from "./bulk-trades";
import templates from "./bulk-trade-templates.json";

export const BUYER_STATUSES = [
  "To contact", "Teaser sent", "No reply", "NDA, specs sent", "Bid in", "LOI or deposit", "Won",
  "Declined: price", "Declined: specs", "Declined: logistics", "Declined: timing",
] as const;
export const BID_UNITS = ["kWh", "pack", "cell"] as const;
export const CURRENCIES = ["EUR", "USD", "GBP"] as const;
export const FIRMNESS = ["firm", "indicative"] as const;
export const FIELD_STATUSES = ["confirmed", "unverified", "conflict", "missing"] as const;
export const VISIBILITIES = ["teaser", "after_nda", "after_loi", "never"] as const;
export const FILE_TYPES = [
  "Photos", "Stock list", "Test report", "Datasheet", "Transport documents", "Deck", "Contract", "Other",
] as const;

export type BuyerStatus = (typeof BUYER_STATUSES)[number];
export type BidUnit = (typeof BID_UNITS)[number];
export type Currency = (typeof CURRENCIES)[number];
export type FieldStatus = (typeof FIELD_STATUSES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type FileType = (typeof FILE_TYPES)[number];

/**
 * Files a browser can show safely in a tab: PDFs and raster images. Decided by the file name,
 * never by the uploader's content type. SVG, HTML and everything else only download.
 */
const PREVIEW_TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

export function previewType(fileName: string): string | null {
  const extension = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ? PREVIEW_TYPES[extension] ?? null : null;
}

export const isImage = (fileName: string) => previewType(fileName)?.startsWith("image/") ?? false;

/** Uploads are stored in the database, so keep them small enough for nightly backups. */
export const MAX_TRADE_FILE_BYTES = 25 * 1024 * 1024;

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  teaser: "Teaser",
  after_nda: "After NDA",
  after_loi: "After LOI",
  never: "Never",
};

export const CURRENCY_SYMBOL: Record<Currency, string> = { EUR: "€", USD: "$", GBP: "£" };

export type Bid = {
  id: string;
  buyer_id: string;
  amount: string;
  unit: BidUnit;
  currency: Currency;
  firmness: "firm" | "indicative";
  delivery_terms: string | null;
  payment_terms: string | null;
  expires_on: string | null;
  created_at: string;
};

/** Latest campaign email to the buyer's CRM person for the trade's listing. Opens are noisy. */
export type EmailTracking = {
  campaign: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
};

export type Buyer = {
  id: string;
  name: string;
  person_id: string | null;
  person_email: string | null;
  email_tracking: EmailTracking | null;
  /** Last time the buyer clicked a tracked link from a Gmail draft. */
  link_clicked_at: string | null;
  contact: string | null;
  wants: string | null;
  status: BuyerStatus;
  last_touch_on: string | null;
  last_touch_via: string | null;
  chase_on: string | null;
  latest_bid: Bid | null;
};

export type Contact = {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
};

export type FieldSource = {
  value: string;
  source_label: string | null;
  source_url: string | null;
  source_date: string | null;
};

export type TradeField = FieldSource & {
  field_key: string;
  status: FieldStatus;
  visibility: Visibility;
  alternatives: FieldSource[];
};

export type TradeFile = {
  id: string;
  file_name: string;
  file_type: FileType;
  byte_size: number;
  source_label: string | null;
  source_date: string | null;
  visibility: Visibility;
  created_at: string;
};

export type ProposalKind =
  | "field" | "buyer_update" | "next_step" | "new_buyer" | "file" | "needs_triage" | "link_contact" | "possible_trade";

/** A change the inbox check found in Gmail or Granola. Nothing happens until Alex accepts it. */
export type Proposal = {
  id: string;
  lot_id: string | null;
  kind: ProposalKind;
  target: string | null;
  proposed: Record<string, unknown>;
  summary: string;
  quote: string;
  source_kind: "gmail" | "granola";
  source_url: string | null;
  source_label: string;
  source_at: string | null;
  created_at: string;
};

/** Latest inbox check, for the header. */
export type CheckStatus = { last_run_at: string; status: "running" | "ok" | "failed"; error: string | null } | null;

/** UK times the inbox check runs. */
export const CHECK_TIMES = ["08:00", "10:30", "13:00", "15:30", "18:30"] as const;

/** Next check time as "15:30", or "08:00" (tomorrow) after the last one. */
export function nextCheckTime(now: Date = new Date()): string {
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return CHECK_TIMES.find((time) => time > hhmm) ?? CHECK_TIMES[0];
}

/** "13:00" in UK time for a timestamp. */
export function ukTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

export type TradeDetail = {
  trade: BulkTrade;
  buyers: Buyer[];
  contacts: Contact[];
  fields: TradeField[];
  files: TradeFile[];
  /** True when Gmail drafts get tracked links (a public link address is configured). */
  link_tracking?: boolean;
  /** Open proposals from the inbox check for this trade. */
  proposals?: Proposal[];
};

// ---------------------------------------------------------------------------
// Field templates: one fixed list per trade kind.
// ---------------------------------------------------------------------------

export type NeededFor = "Teaser" | "Bids" | "Shipping" | "Closing";

export type TemplateField = {
  key: string;
  label: string;
  /** Step that cannot happen without it; shown on the Missing list. */
  neededFor: NeededFor;
  /** "Buyers see at" for a new value. Seller price and supplier details are always Never. */
  visibility: Visibility;
};

// The templates live in bulk-trade-templates.json so the Python inbox check reads the same list.
export const FIELD_TEMPLATES = templates.fields as Record<TradeKind, TemplateField[]>;

/** Files every trade needs, and the step each one unlocks. */
export const REQUIRED_FILES = templates.requiredFiles as { type: FileType; label: string; neededFor: NeededFor }[];

export function templateField(kind: TradeKind, key: string): TemplateField | undefined {
  return FIELD_TEMPLATES[kind].find((field) => field.key === key);
}

export type MissingItem = { key: string; label: string; neededFor: NeededFor };

const NEEDED_ORDER: NeededFor[] = ["Teaser", "Bids", "Shipping", "Closing"];

/** Template fields without a usable value and required files not yet uploaded, most urgent step first. */
export function missingItems(kind: TradeKind, fields: TradeField[], files: TradeFile[]): MissingItem[] {
  const byKey = new Map(fields.map((field) => [field.field_key, field]));
  const items: MissingItem[] = [];
  for (const field of FIELD_TEMPLATES[kind]) {
    const row = byKey.get(field.key);
    if (!row || row.status === "missing" || !row.value?.trim()) {
      items.push({ key: `field:${field.key}`, label: field.label, neededFor: field.neededFor });
    }
  }
  const uploaded = new Set(files.map((file) => file.file_type));
  for (const file of REQUIRED_FILES) {
    if (!uploaded.has(file.type)) items.push({ key: `file:${file.type}`, label: file.label, neededFor: file.neededFor });
  }
  return items.sort((a, b) => NEEDED_ORDER.indexOf(a.neededFor) - NEEDED_ORDER.indexOf(b.neededFor));
}

/**
 * Teaser text for buyers: only confirmed or unverified values marked "Teaser", never the seller,
 * location or price. Alex reviews it before anything is sent.
 */
/** Never in a teaser, whatever the field's "buyers see at" says. */
const NEVER_IN_TEASER = new Set(["seller_price", "location", "local_recycler"]);

/** Neutral subject for anything sent to buyers: a trade title can name the seller. */
export const BUYER_SUBJECT = "Battery batch available";

export function firstName(name?: string | null): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** "Hi Sam," from a person's name, or "Hi," without one. */
export function greeting(name?: string | null): string {
  const first = firstName(name);
  return first ? `Hi ${first},` : "Hi,";
}

export function teaserText(trade: BulkTrade, fields: TradeField[], recipient?: string | null): string {
  const kind = trade.trade_kind ?? "packs";
  const byKey = new Map(fields.map((field) => [field.field_key, field]));
  const lines = FIELD_TEMPLATES[kind]
    .filter((template) => !NEVER_IN_TEASER.has(template.key))
    .map((template) => ({ template, row: byKey.get(template.key) }))
    .filter(({ row }) => row && row.visibility === "teaser" && row.value?.trim()
      && (row.status === "confirmed" || row.status === "unverified"))
    .map(({ template, row }) => `${template.label}: ${row!.value.trim()}`);
  return [
    greeting(recipient),
    "",
    "We have a batch available that may fit what you buy:",
    "",
    ...lines.map((line) => `- ${line}`),
    "",
    "Would you like the full specs? We can share more under NDA.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Parsed<T> = { value: T } | { error: string };

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function asObject(body: unknown): Record<string, unknown> | null {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

type Rule = "text" | "date" | readonly string[];

/** Checks known keys only; unknown keys are an error. Empty text and dates become null. */
function parseShape(body: unknown, rules: Record<string, Rule>, required: string[] = []): Parsed<Record<string, unknown>> {
  const input = asObject(body);
  if (!input) return { error: "Body must be an object." };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = rules[key];
    if (!rule) return { error: `Unknown field: ${key}` };
    if (rule === "text") {
      if (value !== null && typeof value !== "string") return { error: `${key} must be text.` };
      out[key] = typeof value === "string" && value.trim() ? value.trim() : null;
    } else if (rule === "date") {
      if (value === null || value === "") out[key] = null;
      else if (isDate(value)) out[key] = value;
      else return { error: `${key} must be a YYYY-MM-DD date.` };
    } else {
      if (!oneOf(rule, value)) return { error: `${key} must be one of: ${rule.join(", ")}.` };
      out[key] = value;
    }
  }
  for (const key of required) {
    if (out[key] === null || out[key] === undefined) return { error: `${key} is required.` };
  }
  return { value: out };
}

export type BuyerInput = Partial<Pick<Buyer, "name" | "person_id" | "contact" | "wants" | "status" | "last_touch_on" | "last_touch_via" | "chase_on">>;
const BUYER_RULES: Record<string, Rule> = {
  name: "text", person_id: "text", contact: "text", wants: "text", status: BUYER_STATUSES,
  last_touch_on: "date", last_touch_via: "text", chase_on: "date",
};

export function parseBuyerInput(body: unknown, creating: boolean): Parsed<BuyerInput> {
  const parsed = parseShape(body, BUYER_RULES, creating ? ["name"] : []);
  if ("error" in parsed) return parsed;
  if ("name" in parsed.value && !parsed.value.name) return { error: "name is required." };
  return parsed as Parsed<BuyerInput>;
}

export type BidInput = Omit<Bid, "id" | "buyer_id" | "created_at" | "amount"> & { amount: number };
const BID_RULES: Record<string, Rule> = {
  unit: BID_UNITS, currency: CURRENCIES, firmness: FIRMNESS,
  delivery_terms: "text", payment_terms: "text", expires_on: "date",
};

export function parseBidInput(body: unknown): Parsed<BidInput> {
  const input = asObject(body);
  if (!input) return { error: "Body must be an object." };
  const { amount, ...rest } = input;
  const number = typeof amount === "string" ? Number(amount) : amount;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return { error: "amount must be a positive number." };
  const parsed = parseShape(rest, BID_RULES, ["unit", "currency", "firmness"]);
  if ("error" in parsed) return parsed;
  return { value: { delivery_terms: null, payment_terms: null, expires_on: null, ...parsed.value, amount: number } as BidInput };
}

export type ContactInput = Partial<Omit<Contact, "id">>;
const CONTACT_RULES: Record<string, Rule> = { name: "text", company: "text", email: "text", phone: "text" };

export function parseContactInput(body: unknown, creating: boolean): Parsed<ContactInput> {
  const parsed = parseShape(body, CONTACT_RULES, creating ? ["name"] : []);
  if ("error" in parsed) return parsed;
  if ("name" in parsed.value && !parsed.value.name) return { error: "name is required." };
  return parsed as Parsed<ContactInput>;
}

export type FieldInput = Partial<Pick<TradeField, "value" | "status" | "visibility" | "source_label" | "source_url" | "source_date">>;
const FIELD_RULES: Record<string, Rule> = {
  value: "text", status: FIELD_STATUSES, visibility: VISIBILITIES,
  source_label: "text", source_url: "text", source_date: "date",
};

export function parseFieldInput(body: unknown): Parsed<FieldInput> {
  const parsed = parseShape(body, FIELD_RULES);
  if ("error" in parsed) return parsed;
  const url = parsed.value.source_url;
  if (typeof url === "string" && !/^https?:\/\//i.test(url)) return { error: "source_url must be an http(s) link." };
  return parsed as Parsed<FieldInput>;
}

export type FileMetaInput = Partial<Pick<TradeFile, "file_type" | "visibility" | "source_label" | "source_date">>;
const FILE_RULES: Record<string, Rule> = {
  file_type: FILE_TYPES, visibility: VISIBILITIES, source_label: "text", source_date: "date",
};

export function parseFileMeta(body: unknown): Parsed<FileMetaInput> {
  return parseShape(body, FILE_RULES) as Parsed<FileMetaInput>;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Sep" for a YYYY-MM-DD date. */
export function shortDate(date: string): string {
  const [, month, day] = date.split("-").map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** "€22/kWh ind." style summary of a bid. */
export function bidLabel(bid: Bid): string {
  const amount = Number(bid.amount).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return `${CURRENCY_SYMBOL[bid.currency]}${amount}/${bid.unit}${bid.firmness === "indicative" ? " ind." : ""}`;
}

export type PersonMatch = { id: string; name: string; company: string | null; email: string | null; opted_out: boolean };
export type CompanyMatch = { id: string; name: string; people: number };

/** Strongest signal first: "Bounced 24 Sep", "Clicked 25 Sep", "Opened …", "Delivered …", "Sent …". */
export function trackingLabel(tracking: EmailTracking): { label: string; tone: "red" | "green" | "grey" } | null {
  const pick = (
    [
      ["Bounced", tracking.bounced_at, "red"],
      ["Clicked", tracking.clicked_at, "green"],
      ["Opened", tracking.opened_at, "grey"],
      ["Delivered", tracking.delivered_at, "grey"],
      ["Sent", tracking.sent_at, "grey"],
    ] as const
  ).find(([, at]) => at);
  if (!pick) return null;
  const [label, at, tone] = pick;
  return { label: `${label} ${shortDate(at!.slice(0, 10))}`, tone };
}
