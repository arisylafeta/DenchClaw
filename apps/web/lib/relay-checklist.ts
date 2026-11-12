/** The deal checklist under Relay AI: what we already have from a seller or buyer, and what is still missing, split into
 * required (needed before we contact the other side) and helpful (changes the price or speed). The tiers follow Matcha's
 * intake reference (the bulk deal playbook). Facts the CRM stores tick themselves; the rest are ticked by Alex or Matcha
 * and kept on the listing as `context.intake_ticks`.
 *
 * Each required item also carries its state for Qualified (relay-front-door.ts, migration 112): how often we asked,
 * whether they said they cannot provide it, and who checked it. A recycling deal has its own required list. */
import { CHECK_FIELD, checklistRoute, docTooOld, qualifyView, QUALIFY_KEYS, type ChecklistRoute, type CheckState, type QualifyView } from "./relay-front-door";

export type ChecklistItem = {
  key: string; label: string; have: boolean; value: string | null; manual: boolean; warn: string | null;
  /** Required items only: asked in how many emails, "they cannot provide it", who checked it and when, and whether the
   * Qualified tick needs it (price and when do not). */
  asked?: number; cannot?: boolean; checkedBy?: string | null; checkedAt?: string | null; forTick?: boolean;
};
export type DealChecklist = {
  listingId: string; kind: "supply" | "demand"; title: string; required: ChecklistItem[]; helpful: ChecklistItem[];
  route?: ChecklistRoute;
  /** The Qualified rule on this deal, and who ticked it. */
  qualify?: QualifyView & { by: string | null; at: string | null };
  /** Something on the checklist was asked for already: the next ask is the second, gaps only. */
  asked?: boolean;
};

export type ChecklistField = {
  field_key: string; value: string | null; status: string | null;
  asked_at?: string | null; asked_count?: number | null; cannot_provide?: boolean | null; checked_by?: string | null; checked_at?: string | null;
};
export type ChecklistDoc = { file_name: string | null; title: string | null; doc_type: string | null; source_date: string | null; created_at: string | null };
export type ChecklistListing = {
  id: string; kind: string; title: string | null; quantity: string | null; location: string | null; clear_by: string | null;
  context: Record<string, unknown> | null; spec: Record<string, unknown> | null;
  volume: number | string | null; volume_unit: string | null; max_price: number | string | null; price_currency: string | null; price_unit: string | null;
  needed_by: string | null; product_family: string | null;
  route?: string | null; qualified_at?: string | null; qualified_by?: string | null;
};

/** Helpful facts the CRM has no column or field for. Only these can be ticked by hand. */
export const MANUAL_KEYS = {
  supply: [["per_pack_health", "Health per pack with tag"], ["split", "Whole lot or split"], ["owner", "Do they own it"]],
  demand: [["tests", "Tests they need"], ["alternatives", "Alternatives, ranked"], ["limits", "Technical limits"], ["payment", "Payment and who collects"]],
} as const;

const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const present = (v: unknown) => v !== null && v !== undefined && String(v).trim() !== "";

function item(key: string, label: string, value: unknown, extra: Partial<ChecklistItem> = {}): ChecklistItem {
  const have = present(value);
  return { key, label, have, value: have ? clip(String(value).trim()) : null, manual: false, warn: null, ...extra };
}

function fieldValue(fields: ChecklistField[], key: string): string | null {
  const f = fields.find((x) => x.field_key === key);
  return f && f.status !== "missing" && present(f.value) ? String(f.value) : null;
}

/** A field's doubt worth showing: a value nobody has confirmed, or two sources that disagree. */
function fieldDoubt(fields: ChecklistField[], ...keys: string[]): string | null {
  const f = keys.map((k) => fields.find((x) => x.field_key === k)).find((x) => x && x.status !== "missing" && present(x.value));
  return f?.status === "conflict" ? "sources disagree" : f?.status === "unverified" ? "unverified" : null;
}

/** "March 2024" style date for a document, and whether it is more than 12 months old at `now` (flagged at intake). */
function docDate(doc: ChecklistDoc, now: Date): { label: string | null; old: boolean } {
  const raw = doc.source_date ?? null;
  const at = raw ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) return { label: null, old: false };
  return { label: at.toLocaleDateString("en-GB", { month: "long", year: "numeric" }), old: docTooOld(raw, now) };
}

const TEST_DOC = /test|report|diagnos|readout|soh|health|qc\b|inspection/i;
const PHOTO_DOC = /\.(jpe?g|png|heic|webp|gif)$/i;

export function buildChecklist(listing: ChecklistListing, fields: ChecklistField[], docs: ChecklistDoc[], now = new Date()): DealChecklist {
  const kind = listing.kind === "demand" ? "demand" : "supply";
  const route = checklistRoute(listing.route, (listing.context ?? {}).recycling);
  return withState(baseChecklist(listing, fields, docs, now, kind, route), listing, fields, kind, route);
}

/** Adds each required item's state and the Qualified rule. */
function withState(list: DealChecklist, listing: ChecklistListing, fields: ChecklistField[], kind: "supply" | "demand", route: ChecklistRoute): DealChecklist {
  const needed = QUALIFY_KEYS[route][kind];
  const states: Record<string, CheckState> = {};
  const required = list.required.map((i) => {
    const f = fields.find((x) => x.field_key === CHECK_FIELD[kind][i.key]);
    const state = { asked: f?.asked_count ?? 0, cannot: !!f?.cannot_provide, checkedBy: f?.checked_by ?? null, checkedAt: f?.checked_at ?? null, forTick: needed.includes(i.key) };
    states[i.key] = { answered: i.have, cannot: state.cannot, checked: !!state.checkedAt, asked: state.asked };
    return { ...i, ...state };
  });
  const labels = Object.fromEntries(required.map((i) => [i.key, i.label]));
  const view = qualifyView(kind, route, states, !!listing.qualified_at, labels);
  // Listings Qualified under the old rule keep it (migration 112).
  const legacy = listing.qualified_by === "before migration 112";
  return { ...list, required, route, asked: required.some((i) => (i.asked ?? 0) > 0),
    qualify: { ...view, qualified: view.qualified || legacy, by: listing.qualified_by ?? null, at: listing.qualified_at ?? null } };
}

function baseChecklist(listing: ChecklistListing, fields: ChecklistField[], docs: ChecklistDoc[], now: Date, kind: "supply" | "demand", route: ChecklistRoute): DealChecklist {
  const ticks = ((listing.context ?? {}) as { intake_ticks?: Record<string, unknown> }).intake_ticks ?? {};
  const manual = MANUAL_KEYS[kind].map(([key, label]) => ({ key, label, have: ticks[key] === true, value: null, manual: true, warn: null }));
  const title = String((listing.context ?? {}).listing_title ?? listing.title ?? "").trim();

  if (kind === "supply" && route === "recycling") {
    const photos = docs.filter((d) => PHOTO_DOC.test(d.file_name ?? "") || /photo|image/i.test(d.doc_type ?? ""));
    return {
      listingId: listing.id, kind, title,
      required: [
        item("what", "What", fieldValue(fields, "model") ?? fieldValue(fields, "chemistry"), { warn: fieldDoubt(fields, "model", "chemistry") }),
        item("how_many", "How many", listing.quantity ?? fieldValue(fields, "quantity"), { warn: fieldDoubt(fields, "quantity") }),
        item("condition", "Condition", fieldValue(fields, "condition"), { warn: fieldDoubt(fields, "condition") }),
        item("where", "Where", listing.location ?? fieldValue(fields, "location"), { warn: fieldDoubt(fields, "location") }),
        item("price", "Price", fieldValue(fields, "seller_price"), { warn: fieldDoubt(fields, "seller_price") }),
        item("when", "Gone by", listing.clear_by ?? fieldValue(fields, "clear_by")),
      ],
      helpful: [item("photos", "Label and condition photos", photos.length ? `${photos.length} on file` : null), ...manual],
    };
  }
  if (kind === "supply") {
    const model = fieldValue(fields, "model");
    const capacity = fieldValue(fields, "capacity");
    const health = fieldValue(fields, "soh") ?? fieldValue(fields, "test_data");
    const isPhoto = (d: ChecklistDoc) => PHOTO_DOC.test(d.file_name ?? "") || /photo|image/i.test(d.doc_type ?? "");
    const photos = docs.filter(isPhoto);
    const tests = docs.filter((d) => !isPhoto(d) && TEST_DOC.test(`${d.title ?? ""} ${d.file_name ?? ""} ${d.doc_type ?? ""}`));
    const latestTest = tests.map((d) => ({ d, date: docDate(d, now) })).sort((a, b) => String(b.d.source_date ?? "").localeCompare(String(a.d.source_date ?? "")))[0];
    const testValue = latestTest ? (latestTest.date.label ? `Dated ${latestTest.date.label}` : "Report on file, no date") : null;
    return {
      listingId: listing.id, kind, title,
      required: [
        item("what", "What", model ? [model, capacity].filter(Boolean).join(" · ") : null, { warn: model && !capacity ? "kWh not stated" : fieldDoubt(fields, "model") }),
        item("how_many", "How many", listing.quantity ?? fieldValue(fields, "quantity"), { warn: fieldDoubt(fields, "quantity") }),
        item("price", "Price", fieldValue(fields, "seller_price"), { warn: fieldDoubt(fields, "seller_price") }),
        item("when", "When", listing.clear_by ?? fieldValue(fields, "clear_by"), { warn: listing.clear_by ? null : fieldDoubt(fields, "clear_by") }),
        item("where", "Where", listing.location ?? fieldValue(fields, "location"), { warn: fieldDoubt(fields, "location") }),
        item("health", "Health", health, { warn: fieldDoubt(fields, "soh", "test_data") }),
      ],
      helpful: [
        item("test_report", "Test report", testValue, { warn: latestTest?.date.old ? "over 12 months old" : latestTest && !latestTest.date.label ? "date unknown" : null }),
        item("photos", "Label photos", photos.length ? `${photos.length} on file` : null),
        ...manual,
      ],
    };
  }

  const spec = (listing.spec ?? {}) as Record<string, unknown>;
  const price = present(listing.max_price) ? `Max ${listing.price_currency ?? ""} ${listing.max_price}${listing.price_unit ? ` per ${listing.price_unit}` : ""}`.replace(/\s+/g, " ") : null;
  const volume = present(listing.volume) ? `${listing.volume}${listing.volume_unit ? ` ${listing.volume_unit}` : ""}` : listing.quantity;
  return {
    listingId: listing.id, kind, title,
    required: [
      item("what", "What", listing.product_family ?? (Array.isArray(spec.makes) && spec.makes.length ? spec.makes.join(", ") : null) ?? fieldValue(fields, "product_family")),
      item("how_many", "How many", volume),
      item("price", "Max price", price ?? fieldValue(fields, "max_price"), { warn: price && !listing.price_unit ? "unit not stated" : null }),
      item("when", "Needed by", listing.needed_by ?? fieldValue(fields, "needed_by")),
      item("where", "Delivery country", listing.location),
    ],
    helpful: [
      item("min_health", "Minimum health", present(spec.min_soh) ? `${spec.min_soh}%` : null),
      ...manual,
    ],
  };
}

/** What is still missing (by label) and what is in but doubtful (label and doubt), split into required and helpful. */
function gapLists(c: DealChecklist): { required: string[]; helpful: string[] } {
  return {
    required: [
      ...c.required.filter((i) => !i.have).map((i) => i.label.toLowerCase()),
      ...c.required.filter((i) => i.have && i.warn).map((i) => `${i.label.toLowerCase()} (${i.warn})`),
    ],
    helpful: c.helpful.filter((i) => !i.have || i.warn).map((i) => (i.warn ? `${i.label.toLowerCase()} (${i.warn})` : i.label.toLowerCase())),
  };
}

/** The sentence Relay AI gets for "Add missing to draft". Null when nothing is missing. */
export function missingInstruction(c: DealChecklist): string | null {
  const { required, helpful } = gapLists(c);
  if (!required.length && !helpful.length) return null;
  return [
    required.length ? `Ask them for, or to confirm, what we still need: ${required.join(", ")}.` : "",
    helpful.length ? `If it fits naturally, also ask for: ${helpful.join(", ")}.` : "",
    "Keep the rest of the email as it is. Never name a price or range yourself.",
  ].filter(Boolean).join(" ");
}

/** The first ask asks for everything; once anything was asked (relay-front-door, migration 112), the next asks only for
 * the gaps. A deal with no ask on record goes by how much it holds, as before. */
const firstAsk = (c: DealChecklist) => (c.asked ? false : c.required.filter((i) => i.have).length <= 2);

/** The required items an ask from this checklist asks for: the ones missing or in doubt, never ones they cannot provide. */
export function askKeys(c: DealChecklist): string[] {
  return c.required.filter((i) => (!i.have || i.warn) && !i.cannot).map((i) => i.key);
}

/** The note "Draft the ask" drafts from: the playbook's first ask while we have two facts or fewer, otherwise only the gaps
 * and doubts. Null when nothing is missing or doubtful. */
export function askInstruction(c: DealChecklist): string | null {
  const { required, helpful } = gapLists(c);
  if (!required.length && !helpful.length) return null;
  if (firstAsk(c)) {
    const docs = c.kind === "demand" ? "their spec sheet, the packs they would accept and the tests they need" : "stock list, label photos, test reports with their dates and datasheets";
    const must = c.required.filter((i) => !i.have).map((i) => i.label.toLowerCase());
    return `First reply from the intake guide: thank them, ask them to send everything they have (${docs}), then list what it must cover: ${must.join(", ")}. Never offer a price.`;
  }
  return [
    "Second reply from the intake guide: thank them for what they sent.",
    required.length ? `Ask them for, or to confirm, what we still need: ${required.join(", ")}, and say why it matters.` : "",
    helpful.length ? `If it fits naturally, also ask for: ${helpful.join(", ")}.` : "",
    "Never name a price or range yourself.",
  ].filter(Boolean).join(" ");
}

/** The short line Review shows for a draft made by "Draft the ask". */
export function askLabel(c: DealChecklist): string {
  if (firstAsk(c)) return "Draft the ask: first ask, everything they have";
  const { required, helpful } = gapLists(c);
  return `Draft the ask: ${[...required, ...helpful].slice(0, 5).join(", ")}`;
}

/** A dismantler's listing permission (`crm_dismantlers.stock_phase`). */
export type DismantlerPhase = "none" | "stock_only" | "marketplace";
