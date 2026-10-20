import type { Demand } from "./bulk-demand";
import { priceLabel, volumeLabel } from "./bulk-demand";
import type { Registry } from "./bulk-registry";
import { shortDate, type FieldStatus, type NeededFor, type TradeField, type Visibility } from "./bulk-trade-details";
import type { TradeKind } from "./bulk-trades";

/**
 * One uniform shape for the Details of any bulk listing. A trade's facts come from crm_bulk_listing_fields,
 * a demand's from its typed columns and spec; the page renders both the same way.
 */
export type Claim = { value: string; source: string | null; url: string | null; date: string | null };
export type Fact = {
  key: string;
  label: string;
  group: string;
  /** What to show, or null when nothing is recorded. */
  value: string | null;
  status: FieldStatus;
  /** Every claim for this fact; more than one means a conflict to settle. */
  claims: Claim[];
  source: Claim | null;
  /** Who may see it (trade facts only). */
  visibility: Visibility | null;
  /** The step that cannot happen without it (trade facts only). */
  neededFor: NeededFor | null;
  /** Shown even when missing, as a gap to close. */
  critical: boolean;
};

export const GROUPS = ["Product", "Commercial", "Logistics", "Project", "Evidence"] as const;
const STEPS: NeededFor[] = ["Teaser", "Bids", "Shipping", "Closing"];

const present = (text: string | null | undefined) => (text && text.trim() ? text.trim() : null);

/** The facts of a supply listing or trade: every registry fact for its kind, filled or not. */
export function supplyFacts(registry: Registry, kind: TradeKind, fields: TradeField[]): Fact[] {
  const byKey = new Map(fields.map((field) => [field.field_key, field]));
  return registry.fields[kind].map((template) => {
    const row = byKey.get(template.key);
    const value = present(row?.value);
    const status: FieldStatus = value ? row!.status : row?.status === "conflict" ? "conflict" : "missing";
    const claims: Claim[] = row
      ? [row, ...row.alternatives].map((claim) => ({ value: claim.value, source: claim.source_label, url: claim.source_url, date: claim.source_date }))
      : [];
    return {
      key: template.key, label: template.label, group: template.group ?? "Product", value, status, claims,
      source: row && (row.source_label || row.source_url || row.source_date)
        ? { value: row.value, source: row.source_label, url: row.source_url, date: row.source_date } : null,
      visibility: row?.visibility ?? template.visibility, neededFor: template.neededFor, critical: false,
    };
  });
}

const list = (values: unknown) => (Array.isArray(values) && values.length ? values.join(", ") : null);

/** The facts of a demand: its core columns, then the buyer-ask attributes from the registry. */
export function demandFacts(registry: Registry, demand: Demand, opts: { pinned?: string[] } = {}): Fact[] {
  const spec = (demand.spec ?? {}) as Record<string, unknown>;
  const status: FieldStatus = demand.basis === "estimated" ? "unverified" : "confirmed";
  const make = (key: string, label: string, group: string, value: string | null, critical = false): Fact => ({
    key, label, group, value, status: value ? status : "missing", claims: [], source: null, visibility: null, neededFor: null, critical,
  });
  const kwh = spec.kwh_min != null || spec.kwh_max != null
    ? spec.kwh_min === spec.kwh_max ? `${spec.kwh_min} kWh` : `${spec.kwh_min ?? "?"}–${spec.kwh_max ?? "?"} kWh`
    : (opts.pinned ?? []).find((text) => text.includes("kWh")) ?? null;
  const facts: Fact[] = [
    make("product_family", "Product", "Product", present(demand.product_family) ?? opts.pinned?.[0] ?? null, true),
    make("quantity", "Quantity", "Product", volumeLabel(demand) ?? present(demand.quantity), true),
    make("capacity", "Capacity per unit", "Product", kwh),
  ];
  for (const key of Object.keys(registry.specLists)) {
    const value = list(spec[key]);
    if (value) facts.push(make(key, registry.specLabels[key], registry.specGroups[key] ?? "Product", value));
  }
  for (const key of Object.keys(registry.specNumbers)) {
    if (key === "kwh_min" || key === "kwh_max" || spec[key] == null) continue;
    facts.push(make(key, registry.specNumbers[key].label, registry.specGroups[key] ?? "Product", key === "min_soh" ? `${spec[key]}%` : String(spec[key])));
  }
  const context = demand.context ?? {};
  const yesNo = (value: boolean | undefined | null, yes: string, no: string) => (value == null ? null : value ? yes : no);
  facts.push(
    make("max_price", "Max price", "Commercial", priceLabel(demand), true),
    make("application", "Intended use", "Project", present(context.application?.replaceAll("_", " "))),
    make("min_usable_energy", "Min usable energy", "Project",
      context.min_usable_energy_kwh_per_pack == null ? null : `${context.min_usable_energy_kwh_per_pack} kWh per pack`),
    make("homogeneous", "One make per container", "Project", yesNo(context.homogeneous_within_container, "Required", "Not required")),
    make("repeat_supply", "Repeat supply", "Project", yesNo(context.repeat_supply_required, "Required", "Not required")),
    make("container_design", "Container design", "Project",
      context.container_design_finalized == null ? null : context.container_design_finalized ? "Finalised" : "Not final, reconfirm before sourcing"),
    make("needed_by", "Needed by", "Logistics", demand.needed_by ? shortDate(demand.needed_by) : null, demand.kind === "request"),
    make("location", "Deliver to", "Logistics", present(demand.location)),
  );
  return facts;
}

/** Facts worth a row: anything recorded, plus the critical gaps. Grouped in the fixed section order. */
export function visibleGroups(facts: Fact[]): { group: string; facts: Fact[] }[] {
  const shown = facts.filter((fact) => fact.value || fact.status === "conflict" || fact.critical);
  const names = [...GROUPS, ...new Set(shown.map((fact) => fact.group))].filter((name, i, all) => all.indexOf(name) === i);
  return names.map((group) => ({ group, facts: shown.filter((fact) => fact.group === group) })).filter((section) => section.facts.length);
}

/** Facts still to collect, by the step that needs them, most urgent step first. */
export function stillNeeded(facts: Fact[]): { step: NeededFor; facts: Fact[] }[] {
  return STEPS.map((step) => ({ step, facts: facts.filter((fact) => fact.neededFor === step && fact.status === "missing") }))
    .filter((entry) => entry.facts.length);
}

/** "Teaser 6/8": facts recorded out of facts needed for each step. Empty for listings without needed-for facts. */
export function readiness(facts: Fact[]): { step: NeededFor; have: number; total: number }[] {
  return STEPS.map((step) => {
    const needed = facts.filter((fact) => fact.neededFor === step);
    return { step, have: needed.filter((fact) => fact.status !== "missing").length, total: needed.length };
  }).filter((entry) => entry.total > 0);
}
