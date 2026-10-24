import "server-only";

// The Suitable supply view for one demand row, and the best-match line for every open row on the Demand list.
import type { Demand } from "../bulk-demand";
import { matchDemand, bestLine, bySeller, fewestSellers, foldDuplicateSupply, type Match, type MatchGroup, type SourceKind } from "../demand-match";
import type { DemandSupply, SupplyGroupView, SupplyUnitView, BestMatchLine } from "../demand-supply-types";
import { feedCandidates, inventoryFor, marketplaceCandidates, matchVerdicts, type MatchVerdict } from "./demand-match-supply";
import { addDemandActivity } from "./bulk-demand-activity";
import { listDemand } from "./bulk-demand";

const GROUPS_SHOWN = 30;
const UNITS_PER_GROUP = 10;
const UNITS_PER_SELLER = 20;
/** Our usual fee: the most we can pay a seller and still keep it, as a share of the buyer's price. */
export const FEE_SHARE = 0.1;

function unitView(m: Match, verdicts: Map<string, MatchVerdict>): SupplyUnitView {
  const c = m.candidate;
  return {
    key: c.key, source: c.source, alsoIn: c.alsoIn, title: c.title, seller: c.seller, make: c.make, model: c.model,
    format: c.format, chemistry: c.chemistry, location: c.location, country: c.country, kwh: c.kwh, kwhEstimated: c.kwhEstimated,
    units: c.units, price: c.price, currency: c.currency, currencyAssumed: c.currencyAssumed,
    eurPerKwh: m.economics.sellerEurPerKwh, eurPerUnit: m.economics.sellerEurPerUnit, marginPct: m.economics.marginPct,
    spreadEur: m.economics.spreadEur, cheapestRank: m.economics.cheapestRank, peers: m.economics.peers,
    verdict: m.verdict, checks: m.checks, photos: c.photos, soh: c.soh, year: c.year, partNumber: c.partNumber,
    href: c.href, seen: c.seen, ai: c.ai, userVerdict: verdicts.get(c.key)?.verdict ?? null,
  };
}

function groupView(g: MatchGroup, verdicts: Map<string, MatchVerdict>): SupplyGroupView {
  const sellers = bySeller(g.matches);
  return {
    key: g.key, label: g.label, verdict: g.verdict, units: g.units, unitsKnown: g.unitsKnown, sellers: g.sellers, sources: g.sources,
    eurPerKwh: g.eurPerKwh, eurPerUnit: g.eurPerUnit, bestMarginPct: g.bestMarginPct, covers: g.covers, small: g.small, checks: g.matches[0].checks,
    items: g.matches.slice(0, UNITS_PER_GROUP).map((m) => unitView(m, verdicts)), more: Math.max(0, g.matches.length - UNITS_PER_GROUP),
    bySeller: sellers.map(({ matches, ...seller }) => ({
      ...seller, items: matches.slice(0, UNITS_PER_SELLER).map((m) => unitView(m, verdicts)), more: Math.max(0, matches.length - UNITS_PER_SELLER),
    })),
    fill: g.covers ? fewestSellers(sellers, g.covers.need) : null,
  };
}

export async function demandSupply(demand: Demand): Promise<DemandSupply> {
  const { candidates, hidden, verdicts, errors } = await inventoryFor(demand.id);
  const result = matchDemand(demand, candidates, hidden);
  const all = result.groups.flatMap((g) => g.matches);
  const shortlisted = all.filter((m) => verdicts.get(m.candidate.key)?.verdict === "shortlist").map((m) => unitView(m, verdicts));
  const missingShortlist = [...verdicts].filter(([key, v]) => v.verdict === "shortlist" && !shortlisted.some((u) => u.key === key)).map(([key]) => key);
  const r = result.requirement;
  return {
    requirement: {
      pinned: r.pinned, unitsNeeded: r.unitsNeeded, kwhNeeded: r.kwhNeeded, buyerEurPerKwh: r.buyerEurPerKwh,
      buyerEurPerUnit: r.buyerEurPerUnit, priceUnit: r.priceUnit, country: r.country,
    },
    groups: [...result.groups.filter((g) => !g.small).slice(0, GROUPS_SHOWN), ...result.groups.filter((g) => g.small).slice(0, 20)]
      .map((g) => groupView(g, verdicts)),
    totalGroups: result.groups.filter((g) => !g.small).length,
    smallGroups: result.groups.filter((g) => g.small).length,
    totalUnits: result.groups.filter((g) => !g.small).reduce((s, g) => s + g.units, 0),
    considered: {
      marketplace: candidates.filter((c) => c.source === "marketplace").length,
      trades: candidates.filter((c) => c.source === "trade" || c.source === "supply").length,
    },
    hiddenCount: hidden.size,
    shortlisted,
    shortlistGone: missingShortlist,
    targetBuyEurPerKwh: r.buyerEurPerKwh != null ? r.buyerEurPerKwh * (1 - FEE_SHARE) : null,
    blocked: result.blocked,
    errors,
    fxNote: result.fxNote,
  };
}

/** Shortlist, Not a fit or Clear for one unit, logged as Supply activity on the demand. */
export async function recordMatchVerdict(demandId: string, input: { key: string; verdict: "shortlist" | "not_a_fit" | "clear"; title: string;
  seller?: string | null; note?: string | null; eurPerKwh?: number | null; href?: string | null }, userId: string | null) {
  const verb = input.verdict === "shortlist" ? "Shortlisted" : input.verdict === "not_a_fit" ? "Not a fit" : "Cleared";
  return addDemandActivity({
    demandId, kind: "supply", title: `${verb}: ${input.title}${input.seller ? ` (${input.seller})` : ""}`,
    body: input.note ?? null, refKind: input.href?.startsWith("http") ? "url" : null,
    refId: input.href?.startsWith("http") ? input.href : null,
    data: { match: { key: input.key, verdict: input.verdict, eur_per_kwh: input.eurPerKwh ?? null } }, actorUserId: userId,
  });
}

let bestCache: { at: number; lines: Promise<Record<string, BestMatchLine>> } | null = null;

/** Best match per open or qualifying row, for the list's Next column. Cached two minutes. */
export function bestMatchLines(fresh = false): Promise<Record<string, BestMatchLine>> {
  if (fresh || !bestCache || Date.now() - bestCache.at > 120_000) {
    const lines = (async () => {
      const [demand, listings] = await Promise.all([listDemand(), marketplaceCandidates().catch(() => [])]);
      const base = listings.map((l) => ({ ...l, alsoIn: [] as SourceKind[] }));
      const out: Record<string, BestMatchLine> = {};
      for (const row of demand.filter((d) => d.status !== "closed")) {
        const [feed, verdicts] = await Promise.all([feedCandidates(row.id), matchVerdicts(row.id)]);
        const hidden = new Set([...verdicts].filter(([, v]) => v.verdict === "not_a_fit").map(([k]) => k));
        const folded = foldDuplicateSupply(feed, base);
        const result = matchDemand(row, [...folded.feed, ...folded.listings], hidden);
        const line = bestLine(result);
        out[row.id] = line
          ? { ...line, groups: result.groups.filter((g) => !g.small).length, shortlisted: [...verdicts.values()].filter((v) => v.verdict === "shortlist").length }
          : { verdict: null, text: result.blocked ? "Too vague to match" : "No match in our inventory", groups: 0,
            shortlisted: [...verdicts.values()].filter((v) => v.verdict === "shortlist").length };
      }
      return out;
    })();
    bestCache = { at: Date.now(), lines };
    lines.catch(() => { if (bestCache?.lines === lines) bestCache = null; });
  }
  return bestCache.lines;
}
