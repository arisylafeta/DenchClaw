// Which CRM buyer companies might want one supply listing, judged from their buyer profile (the buy box).
// Pure and deterministic. A stated, different chemistry or format rules a company out; a missing fact is a gap, not a no.

export type SupplyProfile = {
  /** "LFP", "NMC", ... or null when the supply does not say. */
  chemistry: string | null;
  /** "Cells" | "Modules" | "Packs" | "Systems" or null. */
  format: string | null;
  /** Model / title / cell maker text, lower case, for make matching. */
  text: string;
  /** ISO-2 country of the stock, or null. */
  country: string | null;
};

export type BuyerProfile = {
  chemistries?: string[]; formats?: string[]; makes?: string[]; cell_makers?: string[]; origins?: string[]; wants?: string;
};

export type BuyerFit = { matched: string[]; gaps: string[]; score: number };

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : []);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Null when the profile rules the supply out; otherwise what matched, what is unknown, and a score. At least one positive match is required. */
export function scoreBuyer(supply: SupplyProfile, raw: BuyerProfile): BuyerFit | null {
  const matched: string[] = [];
  const gaps: string[] = [];
  const chems = list(raw.chemistries).map((c) => c.toUpperCase());
  const formats = list(raw.formats);
  if (chems.length) {
    if (!supply.chemistry) gaps.push(`Supply chemistry not stated (buyer wants ${chems.join("/")})`);
    else if (chems.includes(supply.chemistry.toUpperCase())) matched.push(`Chemistry ${supply.chemistry.toUpperCase()}`);
    else return null;
  }
  if (formats.length) {
    if (!supply.format) gaps.push(`Supply format not stated (buyer wants ${formats.join("/")})`);
    else if (formats.some((f) => f.toLowerCase() === supply.format!.toLowerCase())) matched.push(`Format ${supply.format}`);
    else return null;
  }
  const hay = ` ${norm(supply.text)} `;
  const makes = [...list(raw.makes), ...list(raw.cell_makers)];
  if (makes.length) {
    const hit = makes.find((m) => norm(m).length > 1 && hay.includes(` ${norm(m)} `));
    if (hit) matched.push(`Make ${hit}`); else gaps.push(`Buyer names makes (${makes.slice(0, 3).join(", ")}); none is this supply`);
  }
  const origins = list(raw.origins);
  if (origins.length) {
    if (supply.country && origins.some((o) => o.toLowerCase() === supply.country!.toLowerCase())) matched.push(`Origin ${supply.country}`);
    else if (supply.country) gaps.push(`Buyer sources from ${origins.slice(0, 3).join(", ")}; this is ${supply.country}`);
  }
  if (!matched.some((m) => m.startsWith("Chemistry") || m.startsWith("Format"))) return null;
  return { matched, gaps, score: matched.length * 2 - gaps.length };
}

const STAGE_RANK: Record<string, number> = { Customer: 6, Bidding: 5, Qualified: 4, "In conversation": 3, Responded: 2, Contacted: 1, Identified: 0 };
const TIER_RANK: Record<string, number> = { A: 2, B: 1, C: 0 };

/** Stated before researched, then the further along the relationship, then tier, then fit. */
export function compareBuyers(a: { basis: string | null; stage: string | null; tier: string | null; fit: BuyerFit }, b: typeof a): number {
  const rank = (x: typeof a) => (x.basis === "stated" ? 1 : 0);
  return rank(b) - rank(a) || (STAGE_RANK[b.stage ?? ""] ?? 0) - (STAGE_RANK[a.stage ?? ""] ?? 0)
    || (TIER_RANK[b.tier ?? ""] ?? -1) - (TIER_RANK[a.tier ?? ""] ?? -1) || b.fit.score - a.fit.score;
}

/** A researched web lead that nobody has contacted, shown collapsed. */
export const isLead = (c: { basis: string | null; stage: string | null }) => c.basis !== "stated" && (!c.stage || c.stage === "Identified");
