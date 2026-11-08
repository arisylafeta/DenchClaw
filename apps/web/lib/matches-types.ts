// The shape both Matches tabs read: a supply listing's ranked buyers and a request's ranked supply are the same
// rows, so the client has one list, one header and one set of actions. Shared by the server functions and the tab.

/** Why a row is here. `live ask` is an open request for this product; the rest name where the stock sits. */
export type MatchTag = "live ask" | "our listing" | "marketplace" | "unlisted stock" | "lead";

/** The offer this row already became, if any. */
export type MatchOffer = { id: string; stage: string; date: string | null };

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
};

/** How one requirement fits: ✓ fits, ≈ close, ? not stated, ✗ misses. Always shown as glyph and word, never colour alone. */
export type FitState = "fits" | "close" | "unstated" | "misses";

export type FitMark = {
  /** The requirement: model, size, format, capacity, chemistry, quantity, price, condition, location. */
  key: string;
  /** What the row has against it, short: "Samsung 50E", "12,400 of 500,000", "Quantity". */
  label: string;
  state: FitState;
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
};
