// The shape both Matches tabs read: a supply listing's ranked buyers and a request's ranked supply are the same
// rows, so the client has one list, one header and one set of actions. Shared by the server functions and the tab.

/** Why a row is here. `live ask` is an open request for this product; the rest name where the stock sits. */
export type MatchTag = "live ask" | "our listing" | "marketplace" | "unlisted stock" | "lead";

/** The offer this row already became, if any. */
export type MatchOffer = {
  id: string; stage: string; date: string | null;
  /** Request rows: the last email has gone unanswered three working days. */
  chaseDue?: boolean;
};

export type MatchRow = {
  /** Stable per listing: `demand:<id>`, `company:<id>`, `listing:<id>`, `trade:<id>`, `supply:<id>` or `stock:<id>`. */
  key: string;
  rank: number;
  name: string;
  /** The supporting line: what they asked for, where, or when we last spoke. */
  detail: string | null;
  tags: MatchTag[];
  /** Why it fits, in one line that cites what matched. */
  reason: string;
  /** What to check before offering; the first is the one that would change the answer. */
  checks: string[];
  /** The counterparty's own price, firm only. Never an estimate or a "from". */
  price: string | null;
  offer: MatchOffer | null;
  companyId: string | null;
  personId: string | null;
  /** The contact email an offer should carry, when we hold one. */
  contact: string | null;
  /** The unlisted stock row behind this match, recorded on the offer it becomes. */
  stockId: string | null;
  /** Request rows only: what they hold, from the source ("Lishen LR21700LH cells · quantity not stated"). */
  holds?: string;
  /** Request rows only: where that comes from, and when ("Catalogue, 8 Oct"). */
  source?: string | null;
  /** Request rows only: one mark per requirement the request states. */
  fit?: FitMark[];
  /** Request rows: where the goods are, by country name. */
  country?: string | null;
  /** Request rows: the source's own words, quoted when the row is opened. */
  quote?: string | null;
  /** Request rows: the source itself, when it has a page. */
  link?: { href: string; label: string } | null;
  /** Request rows: where the line comes from, in words ("marketplace listing", "email", "catalogue"). */
  sourceKind?: string | null;
  /** Request rows: what to ask this seller for. */
  askFor?: string[];
  /**
   * Request rows: the same pack (or cell/module model) from one seller, grouped into one row. Absent for a group of one,
   * which stays a plain row. `stockId` is then the cheapest unit, and `group.stockIds` every unit, cheapest first.
   */
  group?: MatchGroupView | null;
};

/** One unit (a pack) or lot (cells, modules) in a grouped row's units table. */
export type MatchUnit = {
  key: string;
  stockId: string | null;
  /** "Vauxhall Vivaro-e 3100 Dynamic", or a lot's product and quantity. */
  vehicle: string;
  year: number | null;
  /** The seller's stock ref, else the part number; null when neither is stated. */
  ref: string | null;
  /** SoH or condition against the request's minimum: ✓ at or above, ≈ within 5 points below, ✗ further or damaged, ? not stated. */
  soh: { state: FitState; label: string; source: string | null };
  location: string | null;
  price: string | null;
  seen: string | null;
  link: { href: string; label: string } | null;
};

/** A grouped request row: one seller, one pack identity (or one cell/module model), several units. */
export type MatchGroupView = {
  /** "Stellantis 50 kWh pack", "Pack with part 9868397180", "EV pack from Citroen Berlingo", "Samsung INR21700-50E cells". */
  pack: string;
  /** Packs: the units (stated quantities summed, a line at least one). Lots: the number of lines. */
  count: number;
  /** "lots" for cells and modules; null for packs, which read "× 11". */
  countWord: string | null;
  /** The pack identity is not confirmed (no confident pack key, no shared part number): grouped by vehicle and kWh only. */
  unsure: boolean;
  /** "Same pack in" when the group spans more than one vehicle, else null; with the vehicles and how many of each. */
  sameLabel: string | null;
  vehicles: { name: string; n: number }[];
  /** "EUR 2,020–2,210 per pack · Leeds, Warrington · salvage listings, seen 1–7 Nov". */
  meta: string;
  /** "Why these count as the same pack" or "Why this is kept apart". */
  why: { title: string; text: string; source: string | null } | null;
  /** The top unit price is over 2.5× the lowest: kept together, with a "Prices vary a lot" line when opened. */
  priceVaries: boolean;
  /** Cell or module lots rather than packs. */
  lots: boolean;
  /** Cheapest first. */
  units: MatchUnit[];
  stockIds: string[];
  /** The pack type this row counts as in the header: a graph key, a shared part number, or the row itself when unconfirmed. */
  typeKey?: string;
};

/** How one requirement fits: ✓ fits, ≈ close, ? not stated, ✗ misses. Always shown as glyph and word, never colour alone. */
export type FitState = "fits" | "close" | "unstated" | "misses";

export type FitMark = {
  /** The requirement: model, size, format, capacity, chemistry, quantity, price, condition, location. */
  key: string;
  /** What the row has against it, short: "Samsung 50E", "12,400 of 500,000", "Quantity". */
  label: string;
  state: FitState;
  /** The "How it fits" row: the requirement's name, what the buyer asked, what they have. */
  name?: string;
  asked?: string;
  have?: string;
};

/** Stated stock against the request's need. Only stated quantities count. */
export type MatchCoverage = {
  stated: number; need: number; unstated: number;
  /** A ranged ask ("2-13 packs"): `need` is the minimum and this the maximum. */
  needMax?: number | null;
};

/** The one-line "Matched on …" header, and the full key behind it. */
export type MatchKeyView = {
  line: string;
  full: string[];
  /** True for a disputed value or a mixed lot: the header opens itself so the reader sees the detail. */
  open: boolean;
};

export type MatchesResult = {
  id: string;
  kind: "supply" | "demand";
  lotKey: MatchKeyView;
  rows: MatchRow[];
  /** How many candidates were scored, for the quiet line under the header. */
  considered: number;
  blocked: string | null;
  errors: string[];
  /** Requests with a unit count only. */
  coverage?: MatchCoverage | null;
  /** Requests only: the "Matched on" chips and the outreach so far. */
  summary?: RequestSummary | null;
  /** Requests: who is asking, as the Group matches heading names them ("R3 Robotics S.A."). */
  buyer?: string | null;
  /** Requests with pack types: each type, what was found against what is needed. Null when the request has none. */
  lines?: LineCoverage[] | null;
  /** Requests only: the same rows, one per supplier, with all their matching stock (Group matches). */
  suppliers?: SupplierMatch[] | null;
};

/** One of the buyer's pack types, across every supplier: what was found against the need. */
export type LineCoverage = {
  id: string;
  label: string;
  /** "10–20" or "8". */
  need: string;
  qtyMin: number;
  qtyMax: number | null;
  /** Stated packs on this type, all suppliers. */
  found: number;
  /** Of `found`, the packs only close to it (capacity not stated, pack not confirmed). */
  close: number;
  suppliers: number;
  /** fits: confirmed stock (found less close) reaches the fewest needed; close: some found; misses: none. */
  state: "fits" | "close" | "misses";
};

/** One pack type a supplier holds: a Per battery row, seen from the supplier. */
export type SupplierStock = {
  /** The Per battery row it is. */
  rowKey: string;
  pack: string;
  /** Stated packs; 0 with `stated` false when the source gives no number. */
  count: number;
  stated: boolean;
  /** The buyer's pack type it counts towards, or null for other matching stock. */
  line: { id: string; label: string } | null;
  lineState: "fits" | "close" | null;
  /** Why only close: "kWh not stated", "pack not confirmed". */
  why: string | null;
  /** "VW ID.4 12, Audi Q4 e-tron 4", when the type spans vehicles. */
  vehicles: string | null;
  /** Price, places, sources and when seen, as the Per battery row has it. */
  meta: string | null;
  price: string | null;
  priceVaries: boolean;
  stockIds: string[];
  units: number;
};

/** A supplier with every matching pack type they hold (Group matches). */
export type SupplierMatch = {
  /** `company:<id>`, `person:<id>` or `name:<seller>`. */
  key: string;
  name: string;
  countries: string[];
  tags: MatchTag[];
  sourceKinds: string[];
  offer: MatchOffer | null;
  companyId: string | null;
  personId: string | null;
  contact: string | null;
  /** On the buyer's types first (in the request's order), then other matching stock. */
  stock: SupplierStock[];
  /** One entry per buyer pack type, in order: how many this supplier holds of it. */
  cover: { id: string; label: string; count: number; state: "fits" | "close" | "none" }[];
  /** Stated packs on the buyer's types, and other matching stock. */
  onLines: number;
  other: number;
  linesCovered: number;
  /** Confirmed packs that count towards the need: each type counted up to its most. Maybes do not count. */
  needCovered: number;
  /** Nothing on the buyer's types, only other matching stock. */
  otherOnly: boolean;
  /** The Per battery rows behind it, best first: the first is the one Add to offers records. */
  rowKeys: string[];
};

/** One requirement chip; `strong` is the product itself. */
export type RequirementChip = { label: string; strong?: boolean };

export type RequestSummary = {
  chips: RequirementChip[];
  /** Offers on the request: asked (emailed or past candidate), replied, chase due. Null when there are none. */
  outreach: { asked: number; replied: number; chaseDue: number } | null;
  /** "3 suppliers · 32 packs match": distinct suppliers, and units ("packs") or lines ("lots", "units") across the rows. */
  count?: { suppliers: number; units: number; word: string } | null;
  /** Pack requests: how many pack types the grouped rows hold, and how many of those are not confirmed. */
  packTypes?: { types: number; unconfirmed: number } | null;
  /** True once any row is a group: the card's subtitle reads "one row per supplier and pack type". */
  grouped?: boolean;
};
