import { createHash } from "node:crypto";

/**
 * Commercial-buyer stock (REB-577): dismantler stock from `crm_stock_opportunities`, aggregated into
 * supplier-free groups for Jules' commercial-buyer path. Nothing in a `StockGroup` may identify a supplier:
 * no names, CRM ids, supplier references, VINs or source URLs. Group keys are opaque hashes of the spec.
 */

/** One live stock row as loaded for aggregation. Internal: holds the supplier, never sent to the platform. */
export type StockRow = {
  id: string;
  company_id: string | null;
  person_id: string;
  supplier: string | null;
  status: "opportunity" | "listed";
  make: string | null;
  model: string | null;
  format: string | null;
  capacity_kwh: number | null;
  chemistry: string | null;
  powertrain: string | null;
  year: number | null;
  country: string | null;
  quantity: number;
  price_eur_ex_vat: number | null;
  price_eur: number | null;
  seen_on: string | null;
  sync_class: string | null;
};

export type StockFilters = {
  make?: string;
  model?: string;
  format?: "pack" | "module" | "cell";
  chemistry?: string;
  powertrain?: string;
  country?: string;
  kwhMin?: number;
  kwhMax?: number;
  maxPriceEurExVat?: number;
  seenWithinDays?: number;
  limit?: number;
};

export type StockGroup = {
  groupKey: string;
  label: string;
  make: string;
  model: string | null;
  format: string | null;
  capacityKwh: number | null;
  chemistry: string | null;
  powertrain: string | null;
  units: number;
  /** Distinct suppliers; null when fewer than MIN_SOURCES, so a single seller cannot be singled out. */
  sources: number | null;
  /** Empty when fewer than MIN_SOURCES. */
  countries: string[];
  years: { min: number; max: number } | null;
  /** With fewer than MIN_SOURCES only a band rounded to PRICE_BAND_EUR is shown and median is null. */
  priceEurExVat: { min: number; median: number | null; max: number; priced: number } | null;
  /** Rows priced only with VAT included or with unknown VAT. */
  priceEurIncVatOnly: number;
  lastSeen: string | null;
  /** Rows refreshed by a supplier sync or marketplace mirror; null when fewer than MIN_SOURCES. */
  synced: number | null;
};

/** Below this many suppliers a group shows no supplier count, countries or exact prices. */
export const MIN_SOURCES = 3;
export const PRICE_BAND_EUR = 500;

const MAKE_ALIASES: Record<string, string> = {
  vw: "Volkswagen", volkswagen: "Volkswagen", mercedes: "Mercedes-Benz", "mercedes-benz": "Mercedes-Benz",
  "mercedes benz": "Mercedes-Benz", citroen: "Citroën", "citroën": "Citroën", skoda: "Škoda", "škoda": "Škoda",
  bmw: "BMW", mg: "MG", byd: "BYD", ds: "DS", kia: "Kia", seat: "SEAT", cupra: "Cupra",
};

const clean = (value: string | null | undefined) => value?.replace(/\s+/g, " ").trim() || null;

export function normalMake(value: string | null | undefined): string | null {
  const make = clean(value);
  if (!make) return null;
  const alias = MAKE_ALIASES[make.toLowerCase()];
  if (alias) return alias;
  return make.length <= 3 ? make.toUpperCase() : make[0].toUpperCase() + make.slice(1).toLowerCase();
}

export function normalFormat(value: string | null | undefined): string | null {
  const format = clean(value)?.toLowerCase();
  return format === "pack" || format === "module" || format === "cell" ? format : null;
}

/** kWh to one decimal so 50 and 50.0 group together; implausible values are dropped. */
export function normalKwh(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 2000 ? Math.round(value * 10) / 10 : null;
}

function specKey(row: StockRow) {
  return [normalMake(row.make), clean(row.model)?.toLowerCase(), normalFormat(row.format), normalKwh(row.capacity_kwh),
    clean(row.chemistry)?.toUpperCase()].map((part) => part ?? "").join("|");
}

/** Opaque, stable key for a spec. It is a hash of the spec only, so it never encodes a supplier or a row id. */
export function groupKeyFor(row: StockRow): string {
  return `grp_${createHash("sha256").update(specKey(row)).digest("hex").slice(0, 16)}`;
}

const includes = (value: string | null, wanted: string | undefined) =>
  !wanted || (value ?? "").toLowerCase().includes(wanted.trim().toLowerCase());

function daysOld(date: string | null, today: Date) {
  if (!date) return Infinity;
  return (today.getTime() - new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime()) / 86_400_000;
}

export function matchesFilters(row: StockRow, filters: StockFilters, today = new Date()): boolean {
  const kwh = normalKwh(row.capacity_kwh);
  const makeWanted = filters.make ? normalMake(filters.make) : null;
  return Boolean(normalMake(row.make))
    && (!makeWanted || normalMake(row.make) === makeWanted)
    && includes(row.model, filters.model)
    && (!filters.format || normalFormat(row.format) === filters.format)
    && includes(row.chemistry, filters.chemistry)
    && (!filters.powertrain || (row.powertrain ?? "").toLowerCase() === filters.powertrain.trim().toLowerCase())
    && includes(row.country, filters.country)
    && (filters.kwhMin === undefined || (kwh !== null && kwh >= filters.kwhMin))
    && (filters.kwhMax === undefined || (kwh !== null && kwh <= filters.kwhMax))
    && (filters.maxPriceEurExVat === undefined || (row.price_eur_ex_vat !== null && row.price_eur_ex_vat <= filters.maxPriceEurExVat))
    && (filters.seenWithinDays === undefined || daysOld(row.seen_on, today) <= filters.seenWithinDays);
}

const round = (value: number) => Math.round(value);

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function labelFor(group: Pick<StockGroup, "make" | "model" | "capacityKwh" | "format" | "chemistry">) {
  return [group.make, group.model, group.capacityKwh !== null ? `${group.capacityKwh} kWh` : null, group.chemistry, group.format]
    .filter(Boolean).join(" ");
}

/** Supplier-free groups, most units first. */
export function aggregateStock(rows: StockRow[]): StockGroup[] {
  const groups = new Map<string, { rows: StockRow[] }>();
  for (const row of rows) {
    if (!normalMake(row.make)) continue;
    const key = groupKeyFor(row);
    const entry = groups.get(key) ?? { rows: [] };
    entry.rows.push(row);
    groups.set(key, entry);
  }
  const result: StockGroup[] = [];
  for (const [groupKey, { rows: members }] of groups) {
    const first = members[0];
    const exVat = members.map((row) => row.price_eur_ex_vat).filter((price): price is number => typeof price === "number" && price > 0);
    const years = members.map((row) => row.year).filter((year): year is number => typeof year === "number" && year > 1990);
    const seen = members.map((row) => row.seen_on).filter((date): date is string => Boolean(date)).sort();
    const models = new Map<string, number>();
    for (const row of members) { const model = clean(row.model); if (model) models.set(model, (models.get(model) ?? 0) + 1); }
    const group = {
      make: normalMake(first.make)!,
      model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      format: normalFormat(first.format),
      capacityKwh: normalKwh(first.capacity_kwh),
      chemistry: clean(first.chemistry)?.toUpperCase() ?? null,
    };
    const sources = new Set(members.map((row) => row.company_id ?? row.person_id)).size;
    const crowd = sources >= MIN_SOURCES;
    result.push({
      groupKey,
      label: labelFor(group),
      ...group,
      powertrain: clean(first.powertrain),
      units: members.reduce((sum, row) => sum + row.quantity, 0),
      sources: crowd ? sources : null,
      countries: crowd ? [...new Set(members.map((row) => clean(row.country)).filter((country): country is string => Boolean(country)))].sort() : [],
      years: years.length ? { min: Math.min(...years), max: Math.max(...years) } : null,
      priceEurExVat: !exVat.length ? null : crowd
        ? { min: round(Math.min(...exVat)), median: round(median(exVat)), max: round(Math.max(...exVat)), priced: exVat.length }
        : { min: Math.max(PRICE_BAND_EUR, Math.floor(Math.min(...exVat) / PRICE_BAND_EUR) * PRICE_BAND_EUR),
          median: null, max: Math.ceil(Math.max(...exVat) / PRICE_BAND_EUR) * PRICE_BAND_EUR, priced: exVat.length },
      priceEurIncVatOnly: members.filter((row) => row.price_eur_ex_vat === null && row.price_eur !== null).length,
      lastSeen: seen.at(-1)?.slice(0, 10) ?? null,
      synced: crowd ? members.filter((row) => row.sync_class === "synced" || row.sync_class === "marketplace").length : null,
    });
  }
  return result.sort((a, b) => b.units - a.units || a.label.localeCompare(b.label));
}

export type BuyLine = { groupKey: string; quantity: number; targetPriceEur?: number | null; label?: string | null };

export type Allocation = {
  groupKey: string;
  label: string | null;
  wanted: number;
  allocated: number;
  targetPriceEur: number | null;
  rows: { row: StockRow; units: number }[];
};

/**
 * Picks stock for each wanted line: freshest synced rows first, then cheapest ex-VAT price, until the quantity is
 * covered. A line with too little stock takes everything there is; `allocated < wanted` records the shortfall.
 */
export function allocate(lines: BuyLine[], rows: StockRow[]): Allocation[] {
  const byGroup = new Map<string, StockRow[]>();
  for (const row of rows) {
    const key = groupKeyFor(row);
    byGroup.set(key, [...(byGroup.get(key) ?? []), row]);
  }
  const used = new Set<string>();
  return lines.map((line) => {
    const candidates = (byGroup.get(line.groupKey) ?? []).filter((row) => !used.has(row.id)).sort((a, b) =>
      Number(b.sync_class === "synced") - Number(a.sync_class === "synced")
      || (a.price_eur_ex_vat ?? Infinity) - (b.price_eur_ex_vat ?? Infinity)
      || (b.seen_on ?? "").localeCompare(a.seen_on ?? "")
      || a.id.localeCompare(b.id));
    const picked: Allocation["rows"] = [];
    let allocated = 0;
    for (const row of candidates) {
      if (allocated >= line.quantity) break;
      const units = Math.min(row.quantity, line.quantity - allocated);
      picked.push({ row, units });
      used.add(row.id);
      allocated += units;
    }
    const label = (picked[0] ? aggregateStock([picked[0].row])[0]?.label : null) ?? line.label ?? null;
    return { groupKey: line.groupKey, label, wanted: line.quantity, allocated, targetPriceEur: line.targetPriceEur ?? null, rows: picked };
  });
}

/** Allocated rows per supplier, for one candidate offer each. */
export function bySupplier(allocations: Allocation[]) {
  const suppliers = new Map<string, { company_id: string | null; person_id: string; supplier: string | null; lines: { allocation: Allocation; row: StockRow; units: number }[] }>();
  for (const allocation of allocations) {
    for (const { row, units } of allocation.rows) {
      const key = row.company_id ?? `person:${row.person_id}`;
      const entry = suppliers.get(key) ?? { company_id: row.company_id, person_id: row.person_id, supplier: row.supplier, lines: [] };
      entry.lines.push({ allocation, row, units });
      suppliers.set(key, entry);
    }
  }
  return [...suppliers.values()];
}
