// Runs the real apps/web/lib/match/rules.ts against the frozen replay fixtures, so the TypeScript rules
// layer can be gated against the Python A1 arm it was ported from. Same pattern as a0_parity.ts.
//
// Input (one path argument):
//   { cases: [{ id, as_of, listing }],
//     buyers: [{ id, name, profile, stage, tier, basis, last_touch }],
//     dossiers: { [caseId]: { [companyId]: { frontmatter, body } } } }
// Every dossier is already reduced to its strict as-of view by scripts/rebattery/match_replay/dossier.py.
//
// Output: { cases: { [caseId]: { ranked: [{ company_id, name, rank, product_tier, is_lead, last_touch }],
//                                 violations: [{ company_id, code, detail }],
//                                 ranked_lines, violations_lines } } }   (the same, with each buyer's `lines`)
//
// `lines` (optional): { [caseId]: { [companyId]: [{ kind, seen, expires_on, part_number, make, model, format,
// chemistry, kwh, kwh_min, kwh_max, decline_reason }] } }, already filtered to what was known before the case's
// as-of date. Each raw line is keyed here with the production `productKeyFor`, the same builder the lot side uses.
import fs from "node:fs";
import {
  rankA1,
  ruleOut,
  type BuyerFacts,
  type BuyerLine,
  type SupplyFacts,
} from "../../../apps/web/lib/match/rules.ts";
import { productKeyFor } from "../../../apps/web/lib/match/product-key-for.ts";
import { voltageFromText } from "../../../apps/web/lib/match/product-key.ts";

type RawBuyer = {
  id: string;
  name: string;
  profile?: Record<string, unknown> | null;
  stage?: string | null;
  tier?: string | null;
  basis?: string | null;
  last_touch?: string | null;
};
type RawCase = { id: string; as_of: string; listing: Record<string, unknown> };
type DossierView = { frontmatter?: Record<string, unknown> | null; body?: string | null };
type RawLine = {
  kind: string;
  seen: string;
  expires_on?: string | null;
  part_number?: string | null;
  make?: string | null;
  model?: string | null;
  format?: string | null;
  chemistry?: string | null;
  kwh?: number | null;
  kwh_min?: number | null;
  kwh_max?: number | null;
  decline_reason?: string | null;
};
type Input = {
  cases: RawCase[];
  buyers: RawBuyer[];
  dossiers?: Record<string, Record<string, DossierView>>;
  lines?: Record<string, Record<string, RawLine[]>>;
};

const toBuyerLine = (raw: RawLine): BuyerLine => {
  const productKey = productKeyFor({
    partNumbers: raw.part_number ? [raw.part_number] : null,
    make: raw.make, model: raw.model, format: raw.format, chemistry: raw.chemistry,
    kwh: raw.kwh, kwhMin: raw.kwh_min, kwhMax: raw.kwh_max,
  });
  return {
    kind: raw.kind, productKey, make: raw.make ?? null, model: raw.model ?? null, format: raw.format ?? null,
    chemistry: raw.chemistry ?? null, kwhMin: raw.kwh_min ?? raw.kwh ?? null, kwhMax: raw.kwh_max ?? raw.kwh ?? null,
    firstSeen: raw.seen, lastSeen: raw.seen, expiresOn: raw.expires_on ?? null, declineReason: raw.decline_reason ?? null,
  };
};

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Input;

/** The fixtures write snake_case (they were authored for Python); the rules take the app's own names. */
const toSupplyFacts = (listing: Record<string, unknown>): SupplyFacts => {
  const pick = <T>(camel: string, snake: string): T | null =>
    (listing[camel] ?? listing[snake] ?? null) as T | null;
  return {
    title: pick<string>("title", "title"),
    make: pick<string>("make", "make"),
    model: pick<string>("model", "model"),
    platform: pick<string>("platform", "platform"),
    format: pick<string>("format", "format"),
    chemistry: pick<string>("chemistry", "chemistry"),
    kwh: pick<number>("kwh", "kwh"),
    kwhMin: pick<number>("kwhMin", "kwh_min"),
    kwhMax: pick<number>("kwhMax", "kwh_max"),
    moduleSeries: pick<string>("moduleSeries", "module_series"),
    partNumber: pick<string>("partNumber", "part_number"),
    cellModel: pick<string>("cellModel", "cell_model") ?? (String(listing.format ?? "").toLowerCase() === "cells" ? pick<string>("model", "model") : null),
    // The lot's voltage text is read the way the platform reads a listing's voltage field.
    voltageV: voltageFromText(String(listing.voltage ?? ""), ["packs", "systems"].includes(String(listing.format ?? "").toLowerCase())),
    units: pick<number>("units", "units"),
    sellerPriceEurPerKwh: pick<number>("sellerPriceEurPerKwh", "seller_price_eur_per_kwh"),
    sellerPriceEurPerUnit: pick<number>("sellerPriceEurPerUnit", "seller_price_eur_per_unit"),
    wholeBatch: pick<boolean>("wholeBatch", "whole_batch"),
    damagedMixed: pick<boolean>("damagedMixed", "damaged_mixed"),
    seller: pick<string>("seller", "seller"),
    country: pick<string>("country", "country"),
    soh: pick<number | string>("soh", "soh"),
    tested: pick<boolean | string>("tested", "tested"),
  };
};

const buyerFacts = (buyer: RawBuyer, dossier: DossierView | null, lines: BuyerLine[] | null = null): BuyerFacts => ({
  id: buyer.id,
  name: buyer.name,
  profile: buyer.profile ?? {},
  stage: buyer.stage ?? null,
  tier: buyer.tier ?? null,
  basis: buyer.basis ?? null,
  lastTouch: buyer.last_touch ?? null,
  dossier: dossier ?? null,
  lines,
});

const out: Record<string, unknown> = {};
for (const testCase of input.cases) {
  const views = input.dossiers?.[testCase.id] ?? {};
  const buyers = input.buyers.map((buyer) => buyerFacts(buyer, views[buyer.id] ?? null));
  const withLines = input.buyers.map((buyer) => buyerFacts(
    buyer, views[buyer.id] ?? null, (input.lines?.[testCase.id]?.[buyer.id] ?? []).map(toBuyerLine)));
  const listing = toSupplyFacts(testCase.listing);
  const run = (facts: BuyerFacts[]) => {
    const ranked = rankA1(listing, facts, testCase.as_of, 30, true);
    // The gate's own check: nothing the rules ruled out may appear in the ranking.
    const violations = ranked.flatMap((row) => {
      const buyer = facts.find((candidate) => candidate.id === row.companyId);
      const found = buyer ? ruleOut(listing, buyer) : null;
      return found ? [{ company_id: row.companyId, code: found.code, detail: found.detail }] : [];
    });
    return {
      ranked: ranked.map((row, index) => ({
        company_id: row.companyId,
        name: row.name,
        rank: index + 1,
        product_tier: row.productTier,
        line_kind: row.lineKind ?? 0,
        line_recency: row.lineRecency ?? 0,
        price_fit: row.priceFit,
        price_basis: row.priceBasis,
        price_margin: row.priceMargin,
        is_lead: row.isLead,
        last_touch: row.lastTouch,
      })),
      violations,
    };
  };
  const plain = run(buyers);
  const lined = run(withLines);
  out[testCase.id] = {
    ranked: plain.ranked, violations: plain.violations,
    ranked_lines: lined.ranked, violations_lines: lined.violations,
  };
}
process.stdout.write(JSON.stringify({ cases: out }));
