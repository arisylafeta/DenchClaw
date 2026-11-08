// Matches v4, slice 2: identical stock from one seller becomes one row. Packs group within one seller by vehicle (make
// and model family), format and a kWh band; part numbers and graph keys never split one vehicle (Ari, 8 Nov). Different
// vehicles join only on a confident shared identity: the battery graph's curated pack key, directly or through a part
// number that inherits it (withPackIdentity, Ari 28 Oct 2026), or one identical listed part number. A group with no
// confirmed pack is marked "Pack type not confirmed". Cells and modules group by seller and cell or module model
// (lots). A group of one stays a plain row. Pure: no database, so the tests and the before/after report see exactly
// what the tab sees.
import { cleanModel, modelFamily, NAMED_PACK, normalMake, packLabel, partKey, specKey, withPackIdentity, type StockRow as CommercialRow } from "../commercial-stock";
import { bySeller, makeAndModel, toEur, type Candidate, type Match, type Requirement } from "../demand-match";
import { productName, unitsPhrase } from "./fit-marks";
import type { FitMark, FitState, MatchGroupView, MatchRow, MatchUnit, RequestSummary } from "../matches-types";

/** `details.battery_graph` on a stock line, when the graph found a pack (`found = yes`). */
export type GraphMatch = {
  pack_key: string | null; confidence: string | null; pack: string | null;
  usable_kwh: number | null; gross_kwh: number | null; chemistry: string | null; voltage: string | null;
  /** What the graph matched on: "part number", "VIN", "model", and the value it matched. */
  kind: string | null;
  input?: string | null;
  looked_up_on: string | null;
};

/** What pack identity needs from a stock line. */
export type IdentityInput = {
  id: string; make: string | null; model: string | null; format: string | null; capacity_kwh: number | null;
  quantity: number | null; part_numbers: string[] | null; graph: GraphMatch | null;
};

export type PackIdentity = {
  /** `pack|<key>` for a confirmed pack, `pn|<part>` for a stated part number, else the listing-text key (one vehicle). */
  key: string;
  confirmed: boolean;
  /** How the pack is known: the graph matched this line, or a part number inherited it from a line the graph matched. */
  how: "graph" | "part number" | "listing part number" | null;
  name: string | null; usableKwh: number | null; grossKwh: number | null; chemistry: string | null; voltage: string | null;
  confidence: string | null; kind: string | null; lookedUpOn: string | null;
  /** The part number as written, for `pn|` keys and for an identity inherited through one. */
  part: string | null;
};

/** Only these graph answers confirm a pack; a low-confidence key neither confirms nor teaches other lines. */
const CONFIDENT = new Set(["high", "medium"]);

/** A part number that can identify a pack: an OEM-length code with digits, not a date, a phone number or a word. */
function usablePart(value: string | null | undefined): string | null {
  const key = partKey(value);
  return key && (key.match(/\d/g) ?? []).length >= 4 ? key : null;
}

/**
 * The pack identity of every stock line, learned once over all the lines (so a group never depends on which lines one
 * request matched). Scraped part lists are long and full of page text, so only a line's first part number counts.
 */
export function packIdentities(rows: IdentityInput[]): Map<string, PackIdentity> {
  const confident = (row: IdentityInput) => !!row.graph?.pack_key && NAMED_PACK.test(row.graph.pack_key) && CONFIDENT.has((row.graph.confidence ?? "").toLowerCase());
  const asCommercial = (row: IdentityInput, packKey: string | null): CommercialRow => ({
    id: row.id, company_id: null, person_id: "", supplier: null, status: "opportunity", make: row.make, model: row.model, format: row.format,
    capacity_kwh: row.capacity_kwh, chemistry: null, powertrain: null, year: null, country: null, quantity: row.quantity ?? 1,
    price_eur_ex_vat: null, price_eur: null, seen_on: null, sync_class: null,
    pack_key: packKey, pack_name: packKey ? row.graph?.pack ?? null : null,
    usable_kwh: packKey ? row.graph?.usable_kwh ?? null : null, gross_kwh: packKey ? row.graph?.gross_kwh ?? null : null,
    // A line the graph matched on a part number teaches only that part number; any other line teaches and inherits
    // through its first part number only. Listings often add sub-parts (a BMS, a junction box), which must not teach.
    part_numbers: packKey && /part/i.test(row.graph?.kind ?? "") && row.graph?.input ? [row.graph.input] : (row.part_numbers ?? []).slice(0, 1),
  });
  const plain = rows.map((row) => asCommercial(row, confident(row) ? row.graph!.pack_key : null));
  const learned = withPackIdentity(plain);
  const graphOf = new Map(rows.filter(confident).map((row) => [row.graph!.pack_key!, row.graph!]));

  const out = new Map<string, PackIdentity>();
  rows.forEach((row, index) => {
    const after = learned[index];
    const part = (row.part_numbers ?? []).slice(0, 1).find((value) => usablePart(value)) ?? null;
    const base = { name: null, usableKwh: null, grossKwh: null, chemistry: null, voltage: null, confidence: null, kind: null, lookedUpOn: null };
    if (confident(row) || (after.pack_key && NAMED_PACK.test(after.pack_key) && part)) {
      // Confirmed: the graph matched this line, or its stated part number points to exactly one pack the graph knows.
      // A key inherited from listing text alone (same make, model and kWh) is not confirmation: it stays apart below.
      const graph = confident(row) ? row.graph! : graphOf.get(after.pack_key!) ?? null;
      out.set(row.id, {
        ...base, key: `pack|${after.pack_key}`, confirmed: true, how: confident(row) ? "graph" : "part number",
        name: graph?.pack ?? after.pack_name ?? null, usableKwh: graph?.usable_kwh ?? null, grossKwh: graph?.gross_kwh ?? null,
        chemistry: graph?.chemistry || null, voltage: graph?.voltage || null, confidence: graph?.confidence ?? null,
        kind: graph?.kind ?? null, lookedUpOn: graph?.looked_up_on ?? null, part: confident(row) ? null : part,
      });
      return;
    }
    if (part) {
      out.set(row.id, { ...base, key: `pn|${usablePart(part)}`, confirmed: true, how: "listing part number", part });
      return;
    }
    // Not confirmed: the listing text's own key (make, model family, format, kWh), so one vehicle never meets another.
    out.set(row.id, { ...base, key: specKey(asCommercial(row, null)), confirmed: false, how: null, part: null });
  });
  return out;
}

/** What a units table needs from a stock line beyond the candidate. */
export type StockExtra = {
  identity: PackIdentity | null;
  /** Stated damage ("casing", "fire"), or ["damaged"] when only the flag is set. Empty when none. */
  damage: string[];
  /** `details.extra.soh_basis`: "supplier_test", "listing_text". */
  sohBasis: string | null;
  /** `details.extra.soh_text` ("SOH OK"), when the seller says it in words only. */
  sohText: string | null;
};

const SOH_SOURCE: Record<string, string> = { supplier_test: "supplier test", listing_text: "listing", bms_read: "BMS read", test_report: "test report" };

const prettyMake = (make: string) => (make.length > 3 && make === make.toUpperCase() ? make[0] + make.slice(1).toLowerCase() : make);
const noYear = (text: string) => text.replace(/\s+(19|20)\d{2}(\s*-\s*((19|20)?\d{2})?)?$/, "").trim();
/** Stock-list tails a chip does not need: "21->>", " >", ">>", and body codes ("208 II UB, UP, UW, UJ"). */
const tidy = (text: string) => noYear(text.replace(/\s*(\d{2,4}\s*-+)?>+.*$/, "").replace(/(\s+[A-Z0-9]{2,3},)+\s+[A-Z0-9]{2,3}$/, "").trim());
const title = (word: string) => word[0].toUpperCase() + word.slice(1);

/** The vehicle a chip names: make and model family, without trims, years, kWh or brackets ("Citroen Berlingo Electric"). */
export function vehicleName(c: Pick<Candidate, "make" | "model" | "title">): string {
  const make = c.make ? prettyMake(c.make.trim()) : null;
  const model = cleanModel(c.make, c.model);
  return tidy(makeAndModel(make, model ? tidy(model) : null)) || c.title;
}

/** The vehicle in the units table: make and model as listed, without a trailing year (the table has a Year column). */
function unitVehicle(c: Candidate): string {
  const make = c.make ? prettyMake(c.make.trim()) : null;
  return noYear(makeAndModel(make, c.model)) || c.title;
}

/** SoH or condition against the request's minimum: ✓ at or above, ≈ within 5 points below, ✗ further below or damaged. */
export function sohMark(c: Pick<Candidate, "soh">, extra: Pick<StockExtra, "damage" | "sohBasis" | "sohText"> | null, minSoh: number | null): MatchUnit["soh"] {
  const source = extra?.sohBasis ? SOH_SOURCE[extra.sohBasis] ?? extra.sohBasis.replace(/_/g, " ") : null;
  if (extra?.damage.length) {
    const kind = extra.damage.find((entry) => entry !== "damaged" && entry !== "other");
    return { state: "misses", label: kind ? `${title(kind)} damaged` : "Damaged", source: null };
  }
  if (c.soh != null) {
    const pct = Math.round(c.soh);
    const state: FitState = minSoh == null || pct >= minSoh ? "fits" : pct >= minSoh - 5 ? "close" : "misses";
    return { state, label: `SoH ${pct}%`, source };
  }
  return { state: "unstated", label: "Not stated", source: extra?.sohText ? `“${extra.sohText}”` : null };
}

/** "8 Oct", or "8 Oct 2025" once the date is not this year. */
function shortDate(iso: string | null | undefined, now: Date): string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "1–7 Nov", "28 Oct–7 Nov", or one day. */
function dayRange(days: string[], now: Date): string | null {
  const sorted = [...new Set(days.map((day) => day.slice(0, 10)))].sort();
  if (!sorted.length) {
    return null;
  }
  const first = shortDate(sorted[0], now)!;
  const last = shortDate(sorted[sorted.length - 1], now)!;
  if (first === last) {
    return first;
  }
  const [d1, ...rest1] = first.split(" ");
  const [d2, ...rest2] = last.split(" ");
  return rest1.join(" ") === rest2.join(" ") ? `${d1}–${d2} ${rest2.join(" ")}` : `${first}–${last}`;
}

const money = (value: number) => value.toLocaleString("en-GB", { maximumFractionDigits: value < 10 ? 2 : 0 });

/** "EUR 2,020–2,210" from each unit's firm price, in one currency; null when none is priced. */
function priceRange(candidates: Candidate[]): string | null {
  const priced = candidates.filter((c) => c.price != null && c.currency && !c.currencyAssumed);
  if (!priced.length) {
    return null;
  }
  const currency = priced[0].currency!;
  const same = priced.filter((c) => c.currency === currency).map((c) => c.price!);
  const low = Math.min(...same);
  const high = Math.max(...same);
  return low === high ? `${currency} ${money(low)}` : `${currency} ${money(low)}–${money(high)}`;
}

const PLURAL: Record<string, string> = { "salvage listing": "salvage listings", "eBay listing": "eBay listings", "marketplace listing": "marketplace listings", email: "emails" };

const KEY_ORDER = (marks: FitMark[][]) => [...new Set(marks.flatMap((list) => list.map((mark) => mark.key)))];

/**
 * One mark per requirement for the whole group: the shared label when every unit says the same, else a range where
 * units differ ("EUR 2,020–2,210", "49.2–52 kWh", "SoH: 8 of 11 stated"). Mixed states read ≈ (some fit, some do not).
 */
export function groupMarks(req: Requirement, members: { candidate: Candidate; marks: FitMark[] }[], price: string | null): FitMark[] {
  const all = members.map((member) => member.marks);
  const n = members.length;
  const out: FitMark[] = [];
  for (const key of KEY_ORDER(all)) {
    const marks = all.map((list) => list.find((mark) => mark.key === key)).filter((mark): mark is FitMark => !!mark);
    const states = new Set(marks.map((mark) => mark.state));
    const labels = [...new Set(marks.map((mark) => mark.label))];
    const mixed: FitState = states.size === 1 ? marks[0].state : states.has("fits") || states.has("close") ? "close" : states.has("misses") ? "misses" : "unstated";
    const name = marks[0].name;
    if (key === "condition" && req.minSoh != null) {
      const sohs = members.map((member) => member.candidate.soh).filter((soh): soh is number => soh != null).map(Math.round);
      if (!sohs.length) {
        out.push({ key, name, label: "SoH", state: "unstated" });
      } else if (sohs.length < n) {
        out.push({ key, name, label: `SoH: ${sohs.length} of ${n} stated`, state: "close" });
      } else {
        const low = Math.min(...sohs);
        const high = Math.max(...sohs);
        out.push({ key, name, label: low === high ? `SoH ${low}%` : `SoH ${low}–${high}%`, state: low >= req.minSoh ? "fits" : "close" });
      }
      continue;
    }
    if (key === "quantity") {
      const stated = members.filter((member) => member.candidate.units != null);
      const have = stated.reduce((sum, member) => sum + member.candidate.units!, 0);
      const need = req.unitsRange?.min ?? req.unitsNeeded;
      if (!stated.length || !need) {
        out.push(stated.length ? marks[0] : { key, name, label: "Quantity", state: "unstated" });
        continue;
      }
      const label = req.unitsRange ? `${money(have)} available · need ${money(req.unitsRange.min)}–${money(req.unitsRange.max)}` : `${money(have)} of ${money(need)}`;
      out.push({ key, name, label, state: have >= need ? "fits" : "close" });
      continue;
    }
    if (key === "price") {
      const priced = marks.filter((mark) => mark.state !== "unstated").length;
      if (!priced || !price) {
        out.push({ key, name, label: "Price", state: "unstated" });
      } else {
        const state: FitState = priced < n ? "close" : mixed;
        out.push({ key, name, label: state === "misses" ? `${price}, over max` : price, state });
      }
      continue;
    }
    if (labels.length === 1) {
      out.push({ ...marks[0], state: mixed });
      continue;
    }
    const kwh = labels.map((label) => label.match(/^(\d+(?:\.\d+)?) kWh$/)?.[1]).filter((value): value is string => !!value).map(Number);
    if (kwh.length === labels.length) {
      out.push({ key, name, label: `${Math.min(...kwh)}–${Math.max(...kwh)} kWh`, state: mixed });
      continue;
    }
    const stated = marks.filter((mark) => mark.state !== "unstated");
    const statedLabels = [...new Set(stated.map((mark) => mark.label))];
    if (stated.length < marks.length && statedLabels.length === 1) {
      out.push({ key, name, label: `${statedLabels[0]} · ${stated.length} of ${n}`, state: mixed });
      continue;
    }
    const shown = statedLabels.length ? statedLabels : labels;
    out.push({ key, name, label: shown.length <= 2 ? shown.join(" / ") : `${shown[0]} +${shown.length - 1} more`, state: mixed });
  }
  return out;
}

type Member = GroupInput;

const LOT_FORMATS = new Set<Candidate["format"]>(["Cells", "Modules"]);
const foldText = (text: string | null | undefined) => (text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const codeLike = (value: string | null | undefined) =>
  !!value && value.length >= 4 && value.length <= 32 && !/\s/.test(value) && /[a-z]/i.test(value) && /\d/.test(value) && !/^\d/.test(value);

/** A cell or module lot's key within one seller: its format, make and cell or module model. Null for packs. */
function lotKey(member: Member): string | null {
  const c = member.match.candidate;
  if (!LOT_FORMATS.has(c.format)) {
    return null;
  }
  const model = c.model ?? (codeLike(c.supplierRef) ? c.supplierRef : null) ?? c.partNumber;
  return model ? `lot|${c.format}|${foldText(c.make)}|${foldText(model)}` : null;
}

/**
 * The vehicle a pack line groups on within one seller: normalised make and model family (Ari, 8 Nov: one seller's Audi
 * Q4 packs, 77 kWh usable and 82 kWh gross, under several part numbers, are one row). A line that does not name both a
 * make and a model has no vehicle to group by: it never groups.
 */
function vehicleKey(member: Member): string | null {
  const c = member.match.candidate;
  if (LOT_FORMATS.has(c.format) || !c.make?.trim() || !c.model?.trim()) {
    return null;
  }
  // Variant words ("e", "electric", "plus") are dropped as when a kWh pins the pack: the kWh band keeps packs apart.
  const family = modelFamily({ make: c.make, model: c.model }, 0);
  return family ? `${normalMake(c.make) ?? foldText(c.make)}|${family}` : null;
}

/**
 * The identities that join different vehicles from one seller: a high-confidence graph key or one identical listed part
 * number joins any make; a medium key (or a part number that inherits one) joins within one make. Unconfirmed lines
 * have none, so they only ever group within their own vehicle.
 */
function joinKeys(member: Member): string[] {
  const identity = member.extra?.identity;
  if (!identity?.confirmed) {
    return [];
  }
  const crossMake = identity.how === "listing part number" || (identity.confidence ?? "").toLowerCase() === "high";
  const c = member.match.candidate;
  return [`${identity.key}${crossMake ? "" : `|make:${normalMake(c.make) ?? foldText(c.make)}`}`];
}

/** A pack line's or lot's format; a pack, a module and a cell never share a row. */
const formatOf = (member: Member) => member.match.candidate.format ?? "Packs";

/** How a member contributes to the "× N": a pack line counts its stated packs (at least one); a lot counts once. */
const unitCount = (c: Candidate) => (LOT_FORMATS.has(c.format) ? 1 : Math.max(1, Math.round(c.units ?? 1)));

function unitOf(member: Member, minSoh: number | null, now: Date): MatchUnit {
  const c = member.match.candidate;
  const lot = LOT_FORMATS.has(c.format);
  const ref = (c.supplierRef && c.supplierRef.length <= 20 && !/\s/.test(c.supplierRef) ? c.supplierRef : null) ?? c.partNumber ?? null;
  const units = c.units != null ? unitsPhrase(c.units, c.format ?? "Packs") : null;
  return {
    key: member.row.key,
    stockId: member.row.stockId,
    vehicle: lot ? [productName(c), units ?? "quantity not stated"].join(" · ") : `${unitVehicle(c)}${c.units != null && c.units > 1 ? ` · ${units}` : ""}`,
    year: c.year,
    ref,
    soh: sohMark(c, member.extra, minSoh),
    location: c.location ?? c.country ?? null,
    price: member.row.price,
    seen: shortDate(c.observedOn ?? c.seen, now),
    link: member.row.link ? { href: member.row.link.href, label: "Listing" } : null,
  };
}

const eur = (c: Candidate) => toEur(c.price, c.currency);

/** The vehicles in a group, one per make and model family, most units first, named as the first line names it. */
function families(members: Member[]): { key: string; name: string; n: number }[] {
  const out = new Map<string, { key: string; name: string; n: number }>();
  for (const member of members) {
    const c = member.match.candidate;
    const key = vehicleKey(member) ?? vehicleName(c);
    const known = out.get(key);
    // The shortest name of a family is its plainest ("Hyundai IONIQ 5" over "Hyundai IONIQ 5 Premium BEV").
    if (known) Object.assign(known, { n: known.n + unitCount(c), name: vehicleName(c).length < known.name.length ? vehicleName(c) : known.name });
    else out.set(key, { key, name: vehicleName(c), n: unitCount(c) });
  }
  return [...out.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** "77–82 kWh" or "82 kWh" from the members' stated kWh, worded as each line's capacity mark is; null when none says. */
function statedKwh(members: Member[]): string | null {
  const kwhs = members.map((member) => member.match.candidate.kwh).filter((kwh): kwh is number => kwh != null).map((kwh) => Math.round(kwh * 10) / 10);
  if (!kwhs.length) {
    return null;
  }
  const low = Math.min(...kwhs);
  const high = Math.max(...kwhs);
  return low === high ? `${low} kWh` : `${low}–${high} kWh`;
}

/** "a, b and c", or "N models listed" past three. */
const listOf = (names: string[]) => (names.length <= 1 ? names[0] ?? ""
  : names.length > 3 ? `${names.length} models listed` : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The first usable part number each line states, as written. */
const listedPart = (member: Member) => [member.match.candidate.partNumber, ...(member.match.candidate.partNumbers ?? [])]
  .slice(0, 1).find((part): part is string => !!usablePart(part)) ?? null;

/** Part numbers as a note: "0Z1915910CD (5), 0Z1915910AJ", most stated first, three at most. */
function partsNote(members: Member[]): { parts: string[]; text: string | null } {
  const counts = new Map<string, { part: string; n: number }>();
  for (const member of members) {
    const part = listedPart(member);
    if (part) {
      const key = usablePart(part)!;
      counts.set(key, { part: counts.get(key)?.part ?? part, n: (counts.get(key)?.n ?? 0) + 1 });
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n || a.part.localeCompare(b.part));
  const shown = sorted.slice(0, 3).map(({ part, n }) => (n > 1 ? `${part} (${n})` : part)).join(", ");
  return { parts: sorted.map((entry) => entry.part), text: sorted.length ? `${shown}${sorted.length > 3 ? ` and ${sorted.length - 3} more` : ""}` : null };
}

/**
 * The group's title, "Same pack in", and "Why these count as the same pack", from what its members share. Title:
 * "<vehicle> · <pack> " for one vehicle, the pack alone for several (the vehicles show under it). The pack is the battery
 * graph's name when a member is confirmed through it, else "<kWh> pack"; its kWh is always the members' stated range, so
 * it agrees with the capacity mark. Part numbers go in the why-note and the units table, never the title.
 */
function describe(members: Member[], lots: boolean): Pick<MatchGroupView, "pack" | "unsure" | "sameLabel" | "why" | "vehicles"> & { typeKey: string } {
  const first = members[0];
  const c = first.match.candidate;
  const n = members.length;
  if (lots) {
    const name = productName(c);
    return {
      pack: name, unsure: false, sameLabel: null, vehicles: [], typeKey: lotKey(first) ?? first.row.key,
      why: { title: "Why these are one row", text: `One seller and one ${c.format === "Modules" ? "module" : "cell"} model: ${name}. Each line is its own lot, with its own quantity and price.`, source: null },
    };
  }
  const vehicles = families(members);
  const multi = vehicles.length > 1;
  const kwh = statedKwh(members);
  const { parts, text: partsText } = partsNote(members);
  // The pack the graph confirms for most members (directly, or through a stated part number).
  const graphed = members.filter((member) => member.extra?.identity?.confirmed && member.extra.identity.key.startsWith("pack|"));
  const tally = new Map<string, Member[]>();
  graphed.forEach((member) => tally.set(member.extra!.identity!.key, [...(tally.get(member.extra!.identity!.key) ?? []), member]));
  const best = [...tally.values()].sort((a, b) => b.length - a.length)[0]?.[0]?.extra?.identity ?? null;
  // The graph's pack names the row only when the stated kWh agree with it (within 12% of its usable or gross figure):
  // a Zoe listed at 22 kWh under a part number the graph files as the ZE40 (41 kWh) is not titled "ZE40".
  const kwhs = members.map((member) => member.match.candidate.kwh).filter((value): value is number => value != null);
  const packKwh = [best?.usableKwh, best?.grossKwh].filter((value): value is number => value != null);
  const agrees = !kwhs.length || !packKwh.length
    || kwhs.every((value) => value >= Math.min(...packKwh) / 1.12 && value <= Math.max(...packKwh) * 1.12);
  const top = best && agrees ? best : null;
  // Different vehicles only ever meet on a shared confident identity; within one vehicle, one shared part number is one.
  const samePart = parts.length === 1 && members.every((member) => listedPart(member));
  const unsure = !top && !multi && !samePart;

  let pack: string;
  if (top) {
    const label = packLabel(top.name, top.usableKwh) ?? (top.name ? top.name.split(/[,(]/)[0].trim() : "EV pack");
    pack = kwh ? label.replace(/\d+(?:\.\d+)?\s*kWh/i, kwh) : label;
  } else {
    pack = `${kwh ?? "EV"} pack`;
  }
  const vehicle = vehicles[0]?.name ?? c.title;
  // A graph name that already starts with the vehicle ("Renault Zoe phase 2 ZE50 traction pack") is not repeated.
  const lead = foldText(vehicle.split(/\s+/).slice(0, 2).join(" "));
  const title = multi || (top && lead && foldText(pack).startsWith(lead)) ? pack : `${vehicle} · ${pack}`;
  const names = listOf(vehicles.map((entry) => entry.name));
  const asListed = members.filter((member) => !member.extra?.identity?.key.startsWith("pack|")).length;
  const typeKey = top ? top.key : samePart ? `pn|${usablePart(parts[0])}` : multi ? `join|${first.row.key}` : `vehicle|${first.row.key}`;

  if (unsure) {
    return {
      pack: title, unsure: true, sameLabel: null, vehicles, typeKey,
      why: {
        title: "Why these are one row",
        text: `Grouped by vehicle and capacity as listed (${vehicle}${kwh ? `, ${kwh}` : ""}), not by a confirmed pack. ${best
          ? `The battery graph files ${best.part ? `part ${best.part}` : "one line"} as the ${best.name ?? "a pack"}${packKwh.length ? ` (${packKwh.join(" / ")} kWh)` : ""}, which does not agree with the listed kWh.${partsText ? ` Part numbers listed: ${partsText}.` : ""}`
          : partsText ? `Part numbers listed: ${partsText}; the battery graph has no confident match for them.`
          : "No part number is listed, and the battery graph has no confident match."}`,
        source: "Ask the seller for the pack label photo or part number",
      },
    };
  }
  if (!top) {
    // Joined on one identical listed part number (across vehicles), or one vehicle whose lines all state the same one.
    const shared = samePart ? parts[0] : sharedPart(members);
    if (!shared) {
      // Joined on a graph key whose kWh the listings contradict: kept together, but said plainly.
      return {
        pack: title, unsure: false, sameLabel: multi ? "Same pack in" : null, vehicles, typeKey,
        why: {
          title: "Why these count as the same pack",
          text: `The ${names} share the battery graph's ${best?.name ?? "pack"}${packKwh.length ? ` (${packKwh.join(" / ")} kWh)` : ""}, but the listed kWh (${kwh ?? "not stated"}) do not agree with it. Check the pack label before offering.${partsText ? ` Part numbers listed: ${partsText}.` : ""}`,
          source: "Ask the seller for the pack label photo or part number",
        },
      };
    }
    return {
      pack: title, unsure: false, sameLabel: multi ? "Same pack in" : null, vehicles, typeKey,
      why: {
        title: "Why these count as the same pack",
        text: `${samePart ? "Every unit states" : `The ${names} share`} part number ${shared}${samePart && multi ? `, across the ${names}` : ""}.${!samePart && partsText ? ` Part numbers listed: ${partsText}.` : ""} The battery graph has no record of this part yet, so kWh and chemistry are as the listings state them.${!samePart && asListed ? " Lines of one vehicle join by vehicle and capacity as listed." : ""}`,
        source: `Part number as listed by the seller · ${shared}`,
      },
    };
  }
  const facts = [
    top.chemistry && !/^(li-?ion|lithium[- ]ion)$/i.test(top.chemistry) ? top.chemistry : null,
    top.usableKwh != null ? `${top.usableKwh} kWh usable` : top.grossKwh != null ? `${top.grossKwh} kWh` : null,
    top.usableKwh != null && top.grossKwh != null && top.grossKwh !== top.usableKwh ? `${top.grossKwh} kWh gross` : null,
    top.voltage ? `${top.voltage} V` : null,
  ].filter(Boolean);
  const confirmed = tally.get(top.key)!;
  const inherited = confirmed.filter((member) => member.extra?.identity?.how === "part number");
  const source = [
    `Battery graph · ${top.kind ? `matched on ${top.kind}` : "matched"}${top.confidence ? ` · ${top.confidence} confidence` : ""}${top.lookedUpOn ? ` · looked up ${shortDate(top.lookedUpOn, new Date()) ?? top.lookedUpOn}` : ""}`,
    inherited.length ? `${inherited.length === n ? "all" : `${inherited.length} of ${n}`} through their part number${inherited.length > 1 ? "s" : ""} (${[...new Set(inherited.map((member) => member.extra!.identity!.part))].slice(0, 2).join(", ")})` : null,
  ].filter(Boolean).join(" · ");
  const carriers = multi ? (vehicles.length > 3 ? `All ${vehicles.length} models listed carry` : `The ${names} carry`) : `${n === 2 ? "Both" : `All ${n}`} carry`;
  const rest = n - confirmed.length;
  return {
    pack: title, unsure: false, sameLabel: multi ? "Same pack in" : null, vehicles, typeKey,
    why: {
      title: "Why these count as the same pack",
      text: [
        `${carriers} the ${top.name ?? pack}${facts.length ? `: ${facts.join(", ")}` : ""}.`,
        rest ? `${rest === 1 ? "One line has" : `${rest} lines have`} no confirmed pack of ${rest === 1 ? "its" : "their"} own and ${rest === 1 ? "joins" : "join"} by vehicle and capacity as listed${kwh ? ` (${kwh})` : ""}.` : null,
        partsText ? `Part numbers listed: ${partsText}.` : null,
      ].filter(Boolean).join(" "),
      source,
    },
  };
}

/** The listed part number that more than one vehicle states, when there is one. */
function sharedPart(members: Member[]): string | null {
  const seen = new Map<string, { part: string; vehicles: Set<string> }>();
  for (const member of members) {
    const part = listedPart(member);
    if (part) {
      const entry = seen.get(usablePart(part)!) ?? { part, vehicles: new Set<string>() };
      entry.vehicles.add(vehicleKey(member) ?? member.row.key);
      seen.set(usablePart(part)!, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.vehicles.size - a.vehicles.size)[0]?.part ?? null;
}

/** One grouped row from a seller's members, ranked where its best member ranked. */
function groupRow(members: Member[], req: Requirement, now: Date): MatchRow {
  const lots = LOT_FORMATS.has(members[0].match.candidate.format);
  const best = members[0];
  const units = [...members].sort((a, b) => (eur(a.match.candidate) ?? 1e12) - (eur(b.match.candidate) ?? 1e12) || a.row.rank - b.row.rank);
  const cheapest = units[0];
  const candidates = members.map((member) => member.match.candidate);
  const count = lots ? members.length : candidates.reduce((sum, c) => sum + unitCount(c), 0);
  const { pack, unsure, sameLabel, why, vehicles, typeKey } = describe(members, lots);
  const price = priceRange(candidates);
  const per = lots ? (candidates[0].format === "Modules" ? "per module" : "per cell") : "per pack";
  const priced = candidates.filter((c) => c.price != null && !c.currencyAssumed);
  const kinds = [...new Set(candidates.map((c) => c.sourceKind).filter((kind): kind is string => !!kind))]
    .map((kind) => (members.filter((member) => member.match.candidate.sourceKind === kind).length > 1 ? PLURAL[kind] ?? kind : kind));
  const days = candidates.map((c) => c.observedOn ?? c.seen).filter((day): day is string => !!day);
  const when = dayRange(days, now);
  const places = [...new Set(candidates.map((c) => c.location ?? c.country).filter((place): place is string => !!place))];
  const meta = [
    price ? `${price} ${priced.length === 1 || !price.includes("–") ? (priced.length === candidates.length && candidates.length > 1 ? "each" : per) : per}` : "No prices stated",
    places.length ? (places.length <= 3 ? places.join(", ") : `${places.slice(0, 3).join(", ")} +${places.length - 3} more`) : null,
    kinds.length || when ? `${kinds.join(", ") || "seen"}${when ? `${kinds.length ? (days.length > 1 && when.includes("–") ? ", seen " : ", ") : " "}${when}` : ""}` : null,
  ].filter(Boolean).join(" · ");
  const marks = groupMarks(req, members.map((member) => ({ candidate: member.match.candidate, marks: member.row.fit ?? [] })), price);
  const eurs = candidates.map(eur).filter((value): value is number => value != null && value > 0);
  const group: MatchGroupView = {
    pack, count, countWord: lots ? "lots" : null, unsure, sameLabel,
    vehicles: vehicles.map(({ name, n }) => ({ name, n })),
    meta, why, lots, typeKey,
    // Kept together, but flagged: a top price over 2.5× the lowest usually means one line is something else.
    priceVaries: eurs.length > 1 && Math.max(...eurs) > Math.min(...eurs) * 2.5,
    units: units.map((member) => unitOf(member, req.minSoh, now)),
    stockIds: units.map((member) => member.row.stockId).filter((id): id is string => !!id),
  };
  return {
    ...best.row,
    key: `group:${cheapest.row.key}`,
    detail: `${count} ${lots ? "lots" : "packs"}`,
    reason: `${pack} × ${count}`,
    checks: [],
    price,
    companyId: cheapest.row.companyId,
    personId: cheapest.row.personId,
    contact: cheapest.row.contact,
    stockId: cheapest.row.stockId,
    holds: `${pack} × ${count}`,
    source: meta,
    fit: marks,
    quote: null,
    link: null,
    askFor: [...new Set(members.flatMap((member) => member.row.askFor ?? []))],
    group,
  };
}

export type GroupInput = { row: MatchRow; match: Match; extra: StockExtra | null };

/**
 * A group splits where its lines' stated kWh differ by more than `tolerance` (10% by default): a part number or graph
 * key does not always pin one pack (MG4 64 and 77 kWh under one number). One vehicle's lines group within 12%, so
 * usable and gross figures for one pack (Audi Q4: 77 and 82 kWh) stay together. A line with no kWh joins only when
 * there is a single capacity to join; otherwise it stands alone.
 */
export function splitByKwh(members: Member[], tolerance = 0.1): Member[][] {
  const kwh = (member: Member) => member.match.candidate.kwh;
  const stated = members.filter((member) => kwh(member) != null).sort((a, b) => kwh(a)! - kwh(b)!);
  const clusters: Member[][] = [];
  for (const member of stated) {
    const current = clusters[clusters.length - 1];
    if (current && kwh(member)! <= kwh(current[0])! * (1 + tolerance)) current.push(member);
    else clusters.push([member]);
  }
  const unknown = members.filter((member) => kwh(member) == null);
  if (clusters.length <= 1) {
    return [[...(clusters[0] ?? []), ...unknown]];
  }
  return [...clusters, ...unknown.map((member) => [member])];
}

/**
 * One seller's pack lines of one kind and format, as row sets. First by vehicle (make and model family) and a 12% kWh
 * band; part numbers and graph keys never split one vehicle. Then vehicle groups that share a confident identity (a
 * high graph key, or one identical listed part number; a medium key within one make) merge, union-find style, and a
 * merge of several vehicle groups splits again where stated kWh differ by more than 10%.
 */
export function packSets(members: Member[]): Member[][] {
  const byVehicle = new Map<string, Member[]>();
  members.forEach((member) => byVehicle.set(vehicleKey(member)!, [...(byVehicle.get(vehicleKey(member)!) ?? []), member]));
  const vehicles = [...byVehicle.values()].flatMap((list) => splitByKwh(list, 0.12));
  const parent = vehicles.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const owner = new Map<string, number>();
  vehicles.forEach((list, index) => {
    for (const key of new Set(list.flatMap(joinKeys))) {
      const other = owner.get(key);
      if (other === undefined) owner.set(key, index);
      else parent[find(index)] = find(other);
    }
  });
  const merged = new Map<number, number[]>();
  vehicles.forEach((_, index) => merged.set(find(index), [...(merged.get(find(index)) ?? []), index]));
  return [...merged.values()].flatMap((indexes) => {
    const all = indexes.flatMap((index) => vehicles[index]);
    return indexes.length > 1 ? splitByKwh(all) : [all];
  });
}

/**
 * Groups a request's ranked rows: per seller (bySeller, and never across two CRM companies), kind (stock or listing)
 * and format, then packs by vehicle (packSets) and cells or modules by model (lots). Rows that are not stock lines or
 * marketplace listings, or have nothing to group on, stay as they are. A group sits where its best-ranked unit sat;
 * ranks are renumbered.
 */
export function groupStock(given: GroupInput[], req: Requirement, now: Date = new Date()): MatchRow[] {
  // On a cell or module request, a line that states no format is a lot of that kind (an emailed list of loose cells).
  const lotKind: Candidate["format"] = req.cellTokens.length || req.formats.includes("Cells") ? "Cells" : req.formats.includes("Modules") ? "Modules" : null;
  const inputs = given.map((input) => (lotKind && !input.match.candidate.format
    ? { ...input, match: { ...input.match, candidate: { ...input.match.candidate, format: lotKind } } } : input));
  const byKey = new Map(inputs.map((input) => [input.match.candidate.key, input]));
  // Stock lines and marketplace listings group alike (Ari, 8 Nov: one seller's identical marketplace packs were one row each).
  const groupable = inputs.filter((input) => /^(stock|listing):/.test(input.row.key) && (lotKey(input) || vehicleKey(input)));
  const buckets = new Map<string, Member[]>();
  for (const seller of bySeller(groupable.map((input) => input.match))) {
    for (const match of seller.matches) {
      const member = byKey.get(match.candidate.key)!;
      // bySeller folds names ("LKQ Synetiq" and "Synetiq"); two different CRM companies are still two sellers.
      const who = member.row.companyId ?? member.row.personId ?? "";
      // A marketplace listing and an unlisted stock line never share a row: they are offered through different paths.
      const kind = member.row.key.slice(0, member.row.key.indexOf(":"));
      const bucket = `${seller.key}|${who}|${kind}|${lotKey(member) ?? `packs|${formatOf(member)}`}`;
      buckets.set(bucket, [...(buckets.get(bucket) ?? []), member]);
    }
  }
  const leader = new Map<string, MatchRow>();
  const absorbed = new Set<string>();
  const sets = [...buckets].flatMap(([bucket, members]) => (bucket.includes("|lot|") ? [members] : packSets(members)));
  for (const members of sets) {
    if (members.length < 2) {
      continue;
    }
    members.sort((a, b) => a.row.rank - b.row.rank);
    leader.set(members[0].row.key, groupRow(members, req, now));
    members.slice(1).forEach((member) => absorbed.add(member.row.key));
  }
  return inputs
    .filter((input) => !absorbed.has(input.row.key))
    .map((input) => leader.get(input.row.key) ?? input.row)
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

/** The header's "N suppliers · M packs match", and for pack requests the pack types the rows hold. */
export function groupSummary(rows: MatchRow[], inputs: GroupInput[], req: Requirement): Pick<RequestSummary, "count" | "packTypes" | "grouped"> {
  const packs = req.formats.length > 0 && req.formats.every((format) => format === "Packs");
  const lots = req.formats.some((format) => format === "Cells" || format === "Modules");
  const suppliers = new Set(rows.map((row) => row.companyId ?? row.personId ?? row.name.toLowerCase())).size;
  const units = rows.reduce((sum, row) => sum + (row.group ? row.group.count : packs ? Math.max(1, Math.round(inputs.find((input) => input.row.key === row.key)?.match.candidate.units ?? 1)) : 1), 0);
  const grouped = rows.some((row) => row.group);
  // Pack types as the rows show them: a group counts as its pack (or as itself when unconfirmed), a single line as its identity.
  const identityOf = new Map(inputs.map((input) => [input.row.key, input.extra?.identity ?? null]));
  const types = new Map<string, boolean>();
  for (const row of rows) {
    if (row.group) {
      types.set(row.group.typeKey ?? row.key, !row.group.unsure);
    } else if (identityOf.get(row.key)) {
      const identity = identityOf.get(row.key)!;
      types.set(identity.key, identity.confirmed);
    }
  }
  return {
    count: { suppliers, units, word: packs ? "packs" : lots ? "lots" : "units" },
    packTypes: packs && grouped ? { types: types.size, unconfirmed: [...types.values()].filter((confirmed) => !confirmed).length } : null,
    grouped,
  };
}
