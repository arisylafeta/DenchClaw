import type { BuyerEngagement, BuyerProfile } from "./buyer-profile";

/**
 * The Buyer card on a request, as quick-scan data: what they buy, their price against what they and others paid us,
 * and a handful of terms. Pure: reads the dossier frontmatter copy in `buyer_profile.dossier` when there is one,
 * otherwise the flat buy box. Nothing is invented; a missing fact is left out.
 */

export type PricePoint = { eur_per_kwh: number; seen: string | null; text: string };
export type BuyerChip = { label: string; seen: string | null; bought: boolean };
export type PriceRange = { low: number; high: number };
export type BuyerCardData = {
  basis: "dossier" | "stated" | "researched" | "none";
  /** What the price block is about: the request's product, or "All products" when no price names it. */
  priceTopic: string | null;
  target: (PriceRange & { seen: string | null }) | null;
  paid: (PriceRange & { count: number; last: string | null; points: PricePoint[] }) | null;
  others: (PriceRange & { count: number }) | null;
  chips: BuyerChip[];
  facts: { label: string; value: string }[];
  pastIssue: string | null;
  decides: string | null;
  verified: string | null;
};

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const uniq = (items: (string | null)[]) => [...new Set(items.filter((item): item is string => !!item))];
const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const human = (text: string) => cap(text.replaceAll("_", " "));
const round = (value: number) => Math.round(value * 10) / 10;

/** Words that name a product line: platform and model words plus "<n> kWh". Lowercased. */
export function productTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const kwh = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*kwh/g)].map((m) => `${Number(m[1])} kwh`);
  const words = lower.split(/[^a-z0-9.-]+/).filter((word) => word.length >= 3 && !/^\d/.test(word)
    && !["packs", "pack", "modules", "module", "cells", "cell", "battery", "batteries", "kwh", "any", "make", "and", "for", "the", "with", "used", "new", "nmc", "lfp"].includes(word));
  return uniq([...kwh, ...words]);
}

function priceKwhText(text: string) {
  return [...text.toLowerCase().matchAll(/(\d+(?:\.\d+)?)\s*kwh/g)].map((m) => `${Number(m[1])} kwh`);
}

/** A price is about the request when its note shares a model word, or a kWh size, with the request. */
export function pricesFor(points: PricePoint[], tokens: string[]): PricePoint[] {
  if (!tokens.length) return [];
  return points.filter((point) => {
    const text = point.text.toLowerCase();
    const words = text.split(/[^a-z0-9.-]+/);
    return tokens.some((token) => token.endsWith(" kwh") ? priceKwhText(text).includes(token) : words.includes(token));
  });
}

/** "EUR 20-25/kWh target" keeps its range; otherwise the stored number. */
function targetRange(point: PricePoint): PriceRange {
  const match = point.text.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*\/\s*kwh/i);
  const low = match ? Number(match[1]) : point.eur_per_kwh;
  const high = match ? Number(match[2]) : point.eur_per_kwh;
  return low <= high ? { low, high } : { low: high, high: low };
}

const spread = (values: number[]): PriceRange | null => values.length ? { low: round(Math.min(...values)), high: round(Math.max(...values)) } : null;
const newest = (points: PricePoint[]) => points.map((p) => p.seen).filter((s): s is string => !!s).sort().at(-1) ?? null;

function pricePoints(dossier: Json, basis: string): PricePoint[] {
  return list(dossier.price).map(obj).filter((p) => p.basis === basis && num(p.eur_per_kwh) !== null && num(p.eur_per_kwh)! > 0)
    .map((p) => ({ eur_per_kwh: num(p.eur_per_kwh)!, seen: str(p.seen), text: str(p.currency_original) ?? "" }));
}

function productLabel(product: Json): string | null {
  const kwh = list(product.kwh).map(num).filter((n): n is number => n !== null);
  const size = kwh.length ? `${kwh.length > 1 ? `${Math.min(...kwh)}–${Math.max(...kwh)}` : kwh[0]} kWh` : null;
  const platform = str(product.platform);
  const make = str(product.make);
  const model = str(product.model);
  const shortModel = model && model.length <= 18 ? model : null;
  const name = platform ?? (make && shortModel ? `${make.split(/,| or /)[0]} ${shortModel}` : make ?? shortModel ?? str(product.part_number) ?? (str(product.chemistry) ? `${product.chemistry} ${str(product.format) ?? ""}`.trim() : null));
  if (!name) return null;
  return /kwh/i.test(name) ? name : [name, size].filter(Boolean).join(" ");
}

function dossierChips(dossier: Json): BuyerChip[] {
  const byLabel = new Map<string, BuyerChip>();
  for (const product of list(dossier.products).map(obj)) {
    const label = productLabel(product);
    if (!label) continue;
    const seen = str(product.seen);
    const bought = product.status === "bought";
    const had = byLabel.get(label);
    byLabel.set(label, { label, seen: [had?.seen, seen].filter(Boolean).sort().at(-1) ?? null, bought: bought || !!had?.bought });
  }
  return [...byLabel.values()].sort((a, b) => Number(b.bought) - Number(a.bought) || (b.seen ?? "").localeCompare(a.seen ?? ""));
}

/** A free-text ask list ("MEB 82 kWh packs (asked 2026-01-14)"), one chip per line or semicolon. */
function textChips(wants: string): BuyerChip[] {
  return uniq(wants.split(/\n|;/).map((line) => line.replace(/\((?:asked|said interested|bought)[^)]*\)/gi, "").replace(/\bpacks?\b\s*$/i, "").trim().slice(0, 40)))
    .filter((label) => label.length > 1)
    .map((label) => {
      const line = wants.split(/\n|;/).find((l) => l.includes(label)) ?? "";
      const date = line.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
      return { label, seen: date, bought: /\(bought/i.test(line) };
    });
}

const COLLECTS: Record<string, string> = { own_haulier: "Own haulier", we_deliver: "We deliver", either: "Either" };
const DECIDES: Record<string, string> = { fast: "Decides fast", normal: "Decides in weeks", slow: "Decides slowly" };
const EVIDENCE: Record<string, string> = { tested_soh: "SoH", bms_data: "BMS", test_report: "Test report", label_photos: "Photos", pack_photos: "Photos", photos: "Photos", coc: "CoC" };

export function buyerCard({ profile, engagement, request, market = [] }: {
  profile: BuyerProfile | undefined | null;
  engagement?: BuyerEngagement | null;
  /** The request on screen: its product line and title, used to scope the price block. */
  request: { product_family: string | null; wants: string | null };
  /** Prices other buyers paid us (dossier `paid` prices of other companies). */
  market?: PricePoint[];
}): BuyerCardData {
  const box = obj(profile?.buyer_profile);
  const dossier = obj(box.dossier);
  const hasDossier = Object.keys(dossier).length > 0;
  const basis = hasDossier ? "dossier" : profile?.buyer_profile_basis === "researched" ? "researched" : Object.keys(box).length ? "stated" : "none";

  const tokens = productTokens(request.product_family ?? request.wants);
  const targets = pricePoints(dossier, "stated_target");
  const paidAll = pricePoints(dossier, "paid");
  const scopedTargets = pricesFor(targets, tokens);
  const scopedPaid = pricesFor(paidAll, tokens);
  const scoped = scopedTargets.length > 0 || scopedPaid.length > 0;
  const useTargets = scoped ? scopedTargets : targets;
  const usePaid = scoped ? scopedPaid : paidAll;
  // Other buyers' prices only compare on the request's product; across products the spread means nothing.
  const othersScoped = pricesFor(market, tokens);

  // The newest stated target is what they want now; older targets are history.
  const latestTarget = [...useTargets].sort((a, b) => (b.seen ?? "").localeCompare(a.seen ?? ""))[0];
  const target = latestTarget ? { ...targetRange(latestTarget), seen: latestTarget.seen } : null;
  const paidRange = spread(usePaid.map((p) => p.eur_per_kwh));
  const othersRange = spread(othersScoped.map((p) => p.eur_per_kwh));

  const products = list(dossier.products).map(obj);
  const formats = hasDossier ? uniq(products.map((p) => str(p.format))).map(cap) : list(box.formats).map(str).filter((s): s is string => !!s);
  const chemistries = hasDossier ? uniq(products.map((p) => str(p.chemistry))) : list(box.chemistries).map(str).filter((s): s is string => !!s);
  const quantity = obj(dossier.quantity);
  const unit = (formats[0] ?? "units").toLowerCase();
  const typical = num(quantity.typical_units);
  const minimum = num(quantity.min_units);
  const collects = str(obj(dossier.logistics).collects);
  const needs = uniq(list(dossier.evidence_required).map((e) => EVIDENCE[String(e)] ?? (typeof e === "string" ? human(e) : null)));
  const uses = uniq([...list(dossier.intent), ...list(dossier.capability)].map((e) => (typeof e === "string" ? human(e) : null))).slice(0, 2);
  const minSoh = num(dossier.min_soh) ?? num(box.min_soh);
  const kwhMin = num(box.kwh_min);
  const kwhMax = num(box.kwh_max);
  const deals = Math.max(paidAll.length, engagement?.trades_won ?? 0);
  const facts = [
    formats.length ? { label: "Format", value: formats.join(", ") } : null,
    chemistries.length ? { label: "Chemistry", value: chemistries.join(", ") } : null,
    typical !== null ? { label: "Typical order", value: `${typical} ${unit}` } : null,
    minimum !== null ? { label: "Minimum", value: `${minimum} ${unit}` } : null,
    !hasDossier && (kwhMin !== null || kwhMax !== null) ? { label: "Size", value: `${kwhMin === kwhMax || kwhMax === null ? kwhMin : kwhMin === null ? `up to ${kwhMax}` : `${kwhMin}–${kwhMax}`} kWh` } : null,
    minSoh !== null ? { label: "Min SoH", value: `${minSoh}%` } : null,
    collects ? { label: "Collects", value: COLLECTS[collects] ?? human(collects) } : null,
    needs.length ? { label: "Needs", value: needs.join(", ") } : null,
    uses.length ? { label: "Uses", value: uses.join(", ") } : null,
    deals > 0 ? { label: "Deals with us", value: String(deals) } : null,
  ].filter((fact): fact is { label: string; value: string } => fact !== null);

  const wants = str(box.wants);
  const chips = hasDossier ? dossierChips(dossier)
    : basis === "researched" ? uniq([...list(box.chemistries), ...list(box.formats), ...list(box.makes)].map(str)).map((label) => ({ label, seen: null, bought: false }))
    : wants ? textChips(wants) : [];

  return {
    basis,
    priceTopic: hasDossier ? (scoped ? request.product_family ?? null : "All products") : request.product_family ?? null,
    target,
    paid: paidRange ? { ...paidRange, count: usePaid.length, last: newest(usePaid), points: usePaid } : null,
    others: othersRange ? { ...othersRange, count: othersScoped.length } : null,
    chips,
    facts,
    pastIssue: str(profile?.past_issues),
    decides: DECIDES[String(dossier.decision_speed)] ?? null,
    verified: str(dossier.last_verified),
  };
}

/** "2026-05-05" as "May 2026"; unambiguous, unlike "May 26". */
export function monthYear(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return null;
  const [year, month] = iso.split("-").map(Number);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month - 1]} ${year}`;
}

/** A €/kWh range as "20–25", or one value. */
export const rangeText = (range: PriceRange) => (range.low === range.high ? String(range.low) : `${range.low}–${range.high}`);
