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
//                                 violations: [{ company_id, code, detail }] } } }
import fs from "node:fs";
import {
  rankA1,
  ruleOut,
  type BuyerFacts,
  type SupplyFacts,
} from "../../../apps/web/lib/match/rules.ts";

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
type Input = {
  cases: RawCase[];
  buyers: RawBuyer[];
  dossiers?: Record<string, Record<string, DossierView>>;
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

const buyerFacts = (buyer: RawBuyer, dossier: DossierView | null): BuyerFacts => ({
  id: buyer.id,
  name: buyer.name,
  profile: buyer.profile ?? {},
  stage: buyer.stage ?? null,
  tier: buyer.tier ?? null,
  basis: buyer.basis ?? null,
  lastTouch: buyer.last_touch ?? null,
  dossier: dossier ?? null,
});

const out: Record<string, unknown> = {};
for (const testCase of input.cases) {
  const views = input.dossiers?.[testCase.id] ?? {};
  const buyers = input.buyers.map((buyer) => buyerFacts(buyer, views[buyer.id] ?? null));
  const listing = toSupplyFacts(testCase.listing);
  const ranked = rankA1(listing, buyers, testCase.as_of, 30, true);
  // The gate's own check: nothing the rules ruled out may appear in the ranking.
  const violations = ranked.flatMap((row) => {
    const buyer = buyers.find((candidate) => candidate.id === row.companyId);
    const found = buyer ? ruleOut(listing, buyer) : null;
    return found ? [{ company_id: row.companyId, code: found.code, detail: found.detail }] : [];
  });
  out[testCase.id] = {
    ranked: ranked.map((row, index) => ({
      company_id: row.companyId,
      name: row.name,
      rank: index + 1,
      product_tier: row.productTier,
      price_fit: row.priceFit,
      price_basis: row.priceBasis,
      price_margin: row.priceMargin,
      is_lead: row.isLead,
      last_touch: row.lastTouch,
    })),
    violations,
  };
}
process.stdout.write(JSON.stringify({ cases: out }));
