/** The deal checklist under Relay AI: what we already have from a seller or buyer, and what is still missing, split into
 * required (needed before we contact the other side) and helpful (changes the price or speed). The tiers follow Matcha's
 * intake reference (the bulk deal playbook). Facts the CRM stores tick themselves; the rest are ticked by Alex or Matcha
 * and kept on the listing as `context.intake_ticks`. */

export type ChecklistItem = { key: string; label: string; have: boolean; value: string | null; manual: boolean; warn: string | null };
export type DealChecklist = { listingId: string; kind: "supply" | "demand"; title: string; required: ChecklistItem[]; helpful: ChecklistItem[] };

export type ChecklistField = { field_key: string; value: string | null; status: string | null };
export type ChecklistDoc = { file_name: string | null; title: string | null; doc_type: string | null; source_date: string | null; created_at: string | null };
export type ChecklistListing = {
  id: string; kind: string; title: string | null; quantity: string | null; location: string | null; clear_by: string | null;
  context: Record<string, unknown> | null; spec: Record<string, unknown> | null;
  volume: number | string | null; volume_unit: string | null; max_price: number | string | null; price_currency: string | null; price_unit: string | null;
  needed_by: string | null; product_family: string | null;
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

/** "March 2024" style date for a document, and whether it is over a year old at `now`. */
function docDate(doc: ChecklistDoc, now: Date): { label: string | null; old: boolean } {
  const raw = doc.source_date ?? null;
  const at = raw ? new Date(raw) : null;
  if (!at || Number.isNaN(at.getTime())) return { label: null, old: false };
  return { label: at.toLocaleDateString("en-GB", { month: "long", year: "numeric" }), old: now.getTime() - at.getTime() > 365 * 86_400_000 };
}

const TEST_DOC = /test|report|diagnos|readout|soh|health|qc\b|inspection/i;
const PHOTO_DOC = /\.(jpe?g|png|heic|webp|gif)$/i;

export function buildChecklist(listing: ChecklistListing, fields: ChecklistField[], docs: ChecklistDoc[], now = new Date()): DealChecklist {
  const kind = listing.kind === "demand" ? "demand" : "supply";
  const ticks = ((listing.context ?? {}) as { intake_ticks?: Record<string, unknown> }).intake_ticks ?? {};
  const manual = MANUAL_KEYS[kind].map(([key, label]) => ({ key, label, have: ticks[key] === true, value: null, manual: true, warn: null }));
  const title = String((listing.context ?? {}).listing_title ?? listing.title ?? "").trim();

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
        item("test_report", "Test report", testValue, { warn: latestTest?.date.old ? "over a year old" : latestTest && !latestTest.date.label ? "date unknown" : null }),
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
      item("what", "What", listing.product_family ?? (Array.isArray(spec.makes) && spec.makes.length ? spec.makes.join(", ") : null)),
      item("how_many", "How many", volume),
      item("price", "Max price", price, { warn: price && !listing.price_unit ? "unit not stated" : null }),
      item("when", "Needed by", listing.needed_by),
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

const firstAsk = (c: DealChecklist) => c.required.filter((i) => i.have).length <= 2;

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
