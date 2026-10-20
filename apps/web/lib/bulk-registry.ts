import type { FileType, NeededFor, TemplateField } from "./bulk-trade-details";
import type { TradeKind } from "./bulk-trades";

/**
 * The attribute registry: which facts a trade listing records, what a buyer's ask can contain, the allowed
 * values and the files every trade needs. It lives in the database (crm_bulk_attributes and friends) and is
 * loaded through /api/bulk-trades/registry; nothing here is hard-coded.
 */
export type Registry = {
  /** Fact template per trade kind, in display order. */
  fields: Record<TradeKind, TemplateField[]>;
  requiredFiles: { type: FileType; label: string; neededFor: NeededFor }[];
  /** Buyer-ask lists (chemistries, makes ...): allowed values by key, with display labels. */
  specLists: Record<string, string[]>;
  specLabels: Record<string, string>;
  /** Buyer-ask numbers (kwh_min, min_soh ...) with their allowed range. */
  specNumbers: Record<string, { label: string; min: number; max: number }>;
  volumeUnits: string[];
  priceUnits: string[];
  currencies: string[];
};

export type RegistryRows = {
  attributes: { key: string; side: "listing" | "demand"; label: string; type: string; needed_for: NeededFor | null;
    visibility: TemplateField["visibility"] | null; min: number | null; max: number | null; sort_order: number }[];
  kinds: { attribute_key: string; kind: TradeKind; label: string; sort_order: number }[];
  options: { attribute_key: string; value: string; sort_order: number }[];
  requiredFiles: { file_type: FileType; label: string; needed_for: NeededFor; sort_order: number }[];
};

const bySort = <T extends { sort_order: number }>(a: T, b: T) => a.sort_order - b.sort_order;

export function buildRegistry(rows: RegistryRows): Registry {
  const attribute = new Map(rows.attributes.map((row) => [row.key, row]));
  const fields: Registry["fields"] = { packs: [], cells: [], systems: [], recycling: [] };
  for (const row of [...rows.kinds].sort(bySort)) {
    const attr = attribute.get(row.attribute_key);
    if (!attr?.needed_for || !attr.visibility) continue;
    fields[row.kind].push({ key: row.attribute_key, label: row.label, neededFor: attr.needed_for, visibility: attr.visibility });
  }
  const optionsOf = (key: string) => rows.options.filter((row) => row.attribute_key === key).sort(bySort).map((row) => row.value);
  const demand = rows.attributes.filter((row) => row.side === "demand").sort(bySort);
  const specLists: Registry["specLists"] = {};
  const specLabels: Registry["specLabels"] = {};
  const specNumbers: Registry["specNumbers"] = {};
  for (const row of demand) {
    if (row.type === "set") { specLists[row.key] = optionsOf(row.key); specLabels[row.key] = row.label; }
    else if (row.type === "number") specNumbers[row.key] = { label: row.label, min: Number(row.min), max: Number(row.max) };
  }
  return {
    fields,
    requiredFiles: [...rows.requiredFiles].sort(bySort).map((row) => ({ type: row.file_type, label: row.label, neededFor: row.needed_for })),
    specLists, specLabels, specNumbers,
    volumeUnits: optionsOf("volume_unit"),
    priceUnits: optionsOf("price_unit"),
    currencies: optionsOf("price_currency"),
  };
}

export function templateField(registry: Registry, kind: TradeKind, key: string): TemplateField | undefined {
  return registry.fields[kind].find((field) => field.key === key);
}
