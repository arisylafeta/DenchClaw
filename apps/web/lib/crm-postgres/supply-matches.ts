import "server-only";

// Demand that fits one supply listing, the mirror of the Matches tab on a demand. Reuses `matchDemand` with the
// roles inverted: the supply is the single candidate and every live demand is the ask. Read only, except the verdict log.
import { queryPg } from "../postgres";
import type { Demand } from "../bulk-demand";
import { matchDemand, type Check, type Match } from "../demand-match";
import { listDemand } from "./bulk-demand";
import { getListing } from "./bulk-listings";
import { feedRowCandidate, matchVerdicts, type FeedRow, type MatchVerdict } from "./demand-match-supply";

export type SupplyMatchRow = {
  demandId: string;
  buyer: string;
  title: string;
  quantity: string | null;
  location: string | null;
  verdict: "exact" | "check";
  /** The first check that is not a clean pass, in plain words ("Quantity not stated"). */
  gap: string | null;
  checks: Check[];
  marginPct: number | null;
  /** A pair someone saved before (the inbox check's judgement). */
  saved: { strength: "strong" | "partial"; reason: string } | null;
  userVerdict: "shortlist" | "not_a_fit" | null;
};

export type SupplyMatches = { matches: SupplyMatchRow[]; notAFit: number; blocked: string | null };

const key = (demandId: string) => `demand:${demandId}`;
const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a === b;

/** The buyer's own listings are not supply for them, and a seller's own demand is not a buyer for their stock. */
function ownParty(supply: { company_id: string | null; person_id: string | null; party: string }, d: Demand): boolean {
  return same(supply.company_id, d.company_id) || same(supply.person_id, d.person_id)
    || (!!supply.party.trim() && supply.party.trim().toLowerCase() === (d.buyer ?? "").trim().toLowerCase());
}

const gapOf = (checks: Check[]) => {
  const bad = checks.find((c) => c.state === "fail") ?? checks.find((c) => c.state === "unknown") ?? checks.find((c) => c.state === "partial");
  return bad ? bad.detail : null;
};

export async function supplyMatches(supplyId: string): Promise<SupplyMatches | null> {
  const supply = await getListing(supplyId);
  if (!supply || supply.kind !== "supply") return null;
  const [feed] = await queryPg<FeedRow>(
    `select feed.id, feed.kind, feed.title, feed.seller, feed.size, feed.location, feed.seen, feed.href, null::text as strength, null::text as reason
     from crm_bulk_listing_supply_feed feed where feed.id = $1`, [supplyId]);
  if (!feed) return { matches: [], notAFit: 0, blocked: "This listing is not in the live supply feed (closed, or not an open supply or trade), so there is nothing to match." };
  const [demand, saved, verdicts] = await Promise.all([
    listDemand(),
    queryPg<{ demand_id: string; strength: "strong" | "partial"; reason: string | null }>(
      `select demand_id, strength, reason from crm_bulk_trade_supply_matches where supply_id = $1 and not hidden`, [supplyId]),
    matchVerdicts(supplyId),
  ]);
  const savedBy = new Map(saved.map((s) => [s.demand_id, { strength: s.strength, reason: s.reason ?? "" }]));
  const out: SupplyMatchRow[] = [];
  let notAFit = 0;
  for (const d of demand) {
    if (d.status === "closed" || ownParty(supply, d)) continue;
    const verdict: MatchVerdict | undefined = verdicts.get(key(d.id));
    if (verdict?.verdict === "not_a_fit") { notAFit += 1; continue; }
    const pair = savedBy.get(d.id) ?? null;
    const candidate = { ...feedRowCandidate({ ...feed, strength: pair?.strength ?? null, reason: pair?.reason ?? null }), key: key(d.id) };
    const m: Match | undefined = matchDemand(d, [candidate]).groups[0]?.matches[0];
    // A saved pair stays visible even when the scorer cannot confirm it: it is Check, with the saved reason.
    if (!m && !pair) continue;
    out.push({
      demandId: d.id, buyer: d.buyer, title: d.product_family || d.wants || d.id, quantity: d.quantity, location: d.location,
      verdict: m?.verdict ?? "check", gap: m ? gapOf(m.checks) : pair!.reason || "Saved match", checks: m?.checks ?? [],
      marginPct: m?.economics.marginPct ?? null, saved: pair, userVerdict: verdict?.verdict === "shortlist" ? "shortlist" : null,
    });
  }
  const order = (r: SupplyMatchRow) => (r.userVerdict === "shortlist" ? 0 : r.verdict === "exact" ? 1 : 2);
  out.sort((a, b) => order(a) - order(b) || (b.marginPct ?? -9) - (a.marginPct ?? -9) || a.buyer.localeCompare(b.buyer));
  return { matches: out, notAFit, blocked: null };
}

/** Shortlist, Not a fit or Clear for one demand, kept as Supply activity on the supply so it shows in History. */
export async function recordSupplyVerdict(supplyId: string, input: { demandId: string; verdict: "shortlist" | "not_a_fit" | "clear"; buyer: string; note?: string | null }, userId: string | null) {
  const verb = input.verdict === "shortlist" ? "Shortlisted" : input.verdict === "not_a_fit" ? "Not a fit" : "Cleared";
  const [row] = await queryPg<{ id: string }>(
    `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data, actor_user_id)
     values ($1, 'supply', $2, $3, $4::jsonb, $5) returning id::text`,
    [supplyId, `${verb}: ${input.buyer}`, input.note ?? null, JSON.stringify({ match: { key: key(input.demandId), verdict: input.verdict } }), userId]);
  return row;
}
