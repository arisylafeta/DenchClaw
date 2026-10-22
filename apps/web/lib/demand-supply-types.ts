// Shapes the Suitable supply tab reads. Shared by the server (lib/crm-postgres/demand-supply.ts) and the client.
import type { Check, FillPlan, Format, MatchGroup, SellerGroup, SourceKind } from "./demand-match";

export type SupplyUnitView = {
  key: string;
  source: SourceKind;
  alsoIn: SourceKind[];
  title: string;
  seller: string | null;
  make: string | null;
  model: string | null;
  format: Format | null;
  chemistry: string | null;
  location: string | null;
  country: string | null;
  kwh: number | null;
  kwhEstimated: boolean;
  units: number | null;
  price: number | null;
  currency: string | null;
  currencyAssumed: boolean;
  eurPerKwh: number | null;
  eurPerUnit: number | null;
  marginPct: number | null;
  spreadEur: number | null;
  cheapestRank: number | null;
  peers: number;
  verdict: "exact" | "check";
  checks: Check[];
  photos: number;
  soh: number | null;
  year: number | null;
  partNumber: string | null;
  href: string;
  seen: string | null;
  ai: { strength: "strong" | "partial"; reason: string } | null;
  userVerdict: "shortlist" | "not_a_fit" | null;
};

/** One seller inside a group: one collection. `items` are its packs, best first. */
export type SellerView = Omit<SellerGroup, "matches"> & { items: SupplyUnitView[]; more: number };

export type SupplyGroupView = Pick<MatchGroup, "key" | "label" | "verdict" | "units" | "sellers" | "sources" | "eurPerKwh"
  | "bestMarginPct" | "covers" | "small"> & { checks: Check[]; items: SupplyUnitView[]; more: number;
    /** The group split by seller, and the fewest sellers that fill the ask. */
    bySeller: SellerView[]; fill: FillPlan | null };

export type DemandSupply = {
  requirement: {
    pinned: string[];
    unitsNeeded: number | null;
    kwhNeeded: number | null;
    buyerEurPerKwh: number | null;
    buyerEurPerUnit: number | null;
    country: string | null;
  };
  groups: SupplyGroupView[];
  totalGroups: number;
  /** Groups under 1% of a bulk ask, sent after the rest and hidden until asked for. */
  smallGroups: number;
  totalUnits: number;
  considered: { marketplace: number; trades: number };
  hiddenCount: number;
  shortlisted: SupplyUnitView[];
  /** Shortlisted units that no longer appear in our inventory (sold, withdrawn or edited). */
  shortlistGone: string[];
  /** The most we can pay a seller per kWh and keep our usual fee, when the buyer gave a per-kWh price. */
  targetBuyEurPerKwh: number | null;
  blocked: string | null;
  errors: string[];
  fxNote: string;
};

export type BestMatchLine = {
  verdict: "exact" | "check" | null;
  text: string;
  groups: number;
  shortlisted: number;
};

/**
 * Sellers outside our inventory who likely hold what the buyer wants. Ari's market finder fills these; the drawer
 * only shows them and offers the outreach. Until the finder is connected the list is empty.
 */
export type MarketLead = {
  id: string;
  company: string;
  company_id: string | null;
  contact: string | null;
  email: string | null;
  /** Why we think they have it: "Listed 6 Zoe packs on eBay", "Breaker with 3 Kona donors". */
  signal: string;
  units: number | null;
  ask_price: number | null;
  currency: string | null;
  country: string | null;
  seen: string | null;
  url: string | null;
  status: "new" | "asked" | "quoted" | "declined";
};
