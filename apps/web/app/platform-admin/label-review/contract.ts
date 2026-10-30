/**
 * Label review: shared types and pure rules. No server imports, so the client component and the
 * server actions agree on one contract.
 *
 * A queue entry is one saved OEM-label photo transcription (a stock observation) together with the
 * stored values of the row it belongs to. A person approves, rejects or corrects what the engine read.
 */

export const LABEL_DECISIONS = ["approve", "reject", "correct"] as const;
export type LabelDecision = (typeof LABEL_DECISIONS)[number];

export type ParsedLabel = {
  /** Energy printed on the label in kWh (Wh values are divided by 1000), or null when none is readable. */
  kwh: number | null;
  voltage: number | null;
  ah: number | null;
};

export type LabelMatch = "match" | "mismatch" | "no_energy" | "no_stored";

export type LabelReviewEntry = {
  observationId: string;
  itemId: string;
  itemVersion: number;
  actor: string | null;
  createdAt: string;
  make: string | null;
  model: string | null;
  partNumbers: string[];
  donorYear: string | null;
  /** The transcription exactly as the engine saved it. */
  text: string;
  quote: string | null;
  photoUrl: string;
  photoNumber: number | null;
  otherPhotos: string[];
  /** The supplier's own listing page for this row. Private: never shown to buyers. */
  listingUrl: string | null;
  stored: { packKwh: number | null; voltageNominal: number | null; capacityAh: number | null; packKwhAuthority: string | null };
  parsed: ParsedLabel;
  match: LabelMatch;
  decision: { decision: LabelDecision; note: string; by: string; at: string } | null;
};

export type LabelReviewPage = {
  entries: LabelReviewEntry[];
  total: number;
  decided: number;
  mismatches: number;
};

export type LabelDecisionInput = {
  observationId: string;
  decision: LabelDecision;
  note: string;
  /** Required for "correct": the pack energy in kWh the unit's own label shows. */
  correctedKwh?: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const num = (raw: string): number => Number(raw.replace(",", "."));

/** Reads printed energy, nominal voltage and capacity from a label transcription. */
export function parseLabelText(text: string): ParsedLabel {
  const source = text.replace(/\u00a0/g, " ");
  let kwh: number | null = null;
  const kwhMatch = /(\d{1,3}(?:[.,]\d{1,3})?)\s*kWh/i.exec(source);
  if (kwhMatch) kwh = num(kwhMatch[1]);
  else {
    const whMatch = /(\d{1,3}[ .]?\d{3})\s*Wh/i.exec(source);
    if (whMatch) kwh = num(whMatch[1].replace(/[ .]/g, "")) / 1000;
  }
  const voltage = /(?:Nominal Voltage|U\s*n(?:enn)?|Voltage)\s*[:=]?\s*(\d{2,4}(?:[.,]\d)?)\s*V\b/i.exec(source)
    ?? /\b(\d{2,4}(?:[.,]\d)?)\s*V(?:\s*DC)?\b/.exec(source);
  const ah = /(?:Nominal Capacity|Capacity|C)\s*[:=]?\s*(\d{1,3}(?:[.,]\d)?)\s*Ah\b/i.exec(source)
    ?? /\b(\d{1,3}(?:[.,]\d)?)\s*Ah\b/i.exec(source);
  return {
    kwh: kwh !== null && Number.isFinite(kwh) ? Math.round(kwh * 1000) / 1000 : null,
    voltage: voltage ? num(voltage[1]) : null,
    ah: ah ? num(ah[1]) : null,
  };
}

/** Compares the label energy with the stored pack energy. A 1.5% tolerance absorbs rounding. */
export function compareEnergy(labelKwh: number | null, storedKwh: number | null): LabelMatch {
  if (labelKwh === null) return "no_energy";
  if (storedKwh === null) return "no_stored";
  return Math.abs(labelKwh - storedKwh) <= Math.max(0.05, storedKwh * 0.015) ? "match" : "mismatch";
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Checks a decision before anything is written. Returns the cleaned input or a readable error. */
export function validateDecision(input: unknown): { ok: true; value: LabelDecisionInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Decision must be an object." };
  const raw = input as Record<string, unknown>;
  if (!isUuid(raw.observationId)) return { ok: false, error: "observationId must be a UUID." };
  if (!LABEL_DECISIONS.includes(raw.decision as LabelDecision)) return { ok: false, error: "decision must be approve, reject or correct." };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (note.length > 2000) return { ok: false, error: "Note must be at most 2000 characters." };
  const decision = raw.decision as LabelDecision;
  if (decision === "reject" && note.length < 3) return { ok: false, error: "Say briefly why you reject it." };
  let correctedKwh: number | null = null;
  if (decision === "correct") {
    const value = typeof raw.correctedKwh === "number" ? raw.correctedKwh : Number.NaN;
    if (!Number.isFinite(value) || value <= 0 || value > 400) return { ok: false, error: "Enter the corrected pack energy in kWh (0 to 400)." };
    correctedKwh = Math.round(value * 1000) / 1000;
  }
  return { ok: true, value: { observationId: raw.observationId, decision, note, correctedKwh } };
}

/** The observation body that records a person's decision. Append-only: history is never edited. */
export function decisionObservation(entry: Pick<LabelReviewEntry, "observationId" | "photoUrl" | "photoNumber">, input: LabelDecisionInput, by: string) {
  const verb = { approve: "approved", reject: "rejected", correct: "corrected" }[input.decision];
  const corrected = input.decision === "correct" ? ` Corrected pack energy: ${input.correctedKwh} kWh.` : "";
  return {
    text: `Human label check: ${verb} the engine's reading of observation ${entry.observationId} (supplier photo ${entry.photoNumber ?? "?"}).${corrected}${input.note ? ` Note: ${input.note}` : ""}`,
    quote: `humanLabelCheck:${input.decision}`,
    source: { kind: "text" },
    values: {
      humanLabelCheck: input.decision,
      observationId: entry.observationId,
      photoUrl: entry.photoUrl,
      decidedBy: by,
      note: input.note,
      ...(input.decision === "correct" ? { correctedKwh: input.correctedKwh } : {}),
    },
  };
}

/** The owner instruction stored with a corrected value. */
export function correctionInstruction(entry: Pick<LabelReviewEntry, "observationId">, input: LabelDecisionInput, by: string) {
  return {
    text: `${by} corrected packKwh to ${input.correctedKwh} kWh in the label review (reading of observation ${entry.observationId}).${input.note ? ` ${input.note}` : ""}`,
    source: `${by}, label review`,
  };
}

/** Entries that share a part code are one pack type, so they are checked together. */
export type LabelGroup = {
  key: string;
  title: string;
  subtitle: string;
  entries: LabelReviewEntry[];
  rows: number;
  pending: number;
  mismatches: number;
};

export type LabelGroupDecisionInput = {
  observationIds: string[];
  decision: LabelDecision;
  note: string;
  correctedKwh?: number | null;
};

const normCode = (code: string) => code.toUpperCase().replace(/[\s.\-_/]/g, "");

export function groupKeyOf(entry: Pick<LabelReviewEntry, "partNumbers" | "make" | "model">): string {
  const code = entry.partNumbers.map(normCode).find(Boolean);
  return code ? `pn:${code}` : `nocode:${(entry.make ?? "").toLowerCase()}|${(entry.model ?? "").toLowerCase()}`;
}

/** Groups the queue by part code (rows with no code group by make and model). Groups that still differ come first. */
export function groupEntries(entries: LabelReviewEntry[]): LabelGroup[] {
  const map = new Map<string, LabelReviewEntry[]>();
  for (const e of entries) {
    const key = groupKeyOf(e);
    (map.get(key) ?? map.set(key, []).get(key)!).push(e);
  }
  const groups: LabelGroup[] = [...map].map(([key, list]) => {
    const models = [...new Set(list.map((e) => `${e.make ?? ""} ${e.model ?? ""}`.trim()))];
    const code = list[0].partNumbers[0];
    const rows = new Set(list.map((e) => e.itemId)).size;
    return {
      key,
      title: code ?? `${models[0] || "Unknown"} (no part code)`,
      subtitle: `${models.join(", ")} · ${rows} ${rows === 1 ? "row" : "rows"} · ${list.length} ${list.length === 1 ? "reading" : "readings"}`,
      entries: list,
      rows,
      pending: list.filter((e) => !e.decision).length,
      mismatches: list.filter((e) => !e.decision && e.match === "mismatch").length,
    };
  });
  const rank = (g: LabelGroup) => (g.mismatches ? 0 : g.pending ? 1 : 2);
  return groups.sort((a, b) => rank(a) - rank(b) || b.mismatches - a.mismatches || a.title.localeCompare(b.title));
}

/** Checks a decision made on a whole group. */
export function validateGroupDecision(input: unknown): { ok: true; value: LabelGroupDecisionInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Decision must be an object." };
  const raw = input as Record<string, unknown>;
  const ids = Array.isArray(raw.observationIds) ? raw.observationIds : [];
  if (ids.length === 0 || ids.length > 100 || !ids.every(isUuid)) return { ok: false, error: "Choose 1 to 100 readings." };
  const one = validateDecision({ observationId: ids[0], decision: raw.decision, note: raw.note, correctedKwh: raw.correctedKwh });
  if (!one.ok) return one;
  return { ok: true, value: { observationIds: [...new Set(ids as string[])], decision: one.value.decision, note: one.value.note, correctedKwh: one.value.correctedKwh } };
}
