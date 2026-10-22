import { queryPg } from "../postgres";
import type { Supply, SupplyClosedReason } from "../bulk-supply";
import type { SupplyFeedRow } from "../bulk-supply";
import { companyContextSql } from "./company-context";

const SUPPLY_SELECT = `
  select supply.id, supply.seller, supply.company_id, supply.person_id, supply.contact, supply.email, supply.offers,
    supply.trade_kind, supply.quantity, supply.location, supply.est_tonnes::float8 as est_tonnes,
    supply.est_value_usd::float8 as est_value_usd, supply.size_note, supply.source_kind, supply.source_label,
    supply.source_url, supply.source_quote, to_char(supply.observed_on, 'YYYY-MM-DD') as observed_on, supply.status,
    supply.closed_reason, supply.updated_at, ${companyContextSql("supply.company_id")} as context_notes,
    coalesce((
      select json_agg(json_build_object('demand_id', demand.id, 'buyer', demand.buyer, 'contact', demand.contact,
        'email', demand.email, 'wants', demand.wants, 'kind', demand.kind, 'basis', demand.basis, 'strength', m.strength,
        'reason', m.reason) order by m.strength desc, demand.buyer)
      from crm_bulk_trade_supply_matches m join crm_bulk_demand demand on demand.id = m.demand_id
      where m.supply_id = supply.id and not m.hidden and demand.status = 'open'
    ), '[]'::json) as fits
  from crm_bulk_supply supply`;

/** Every batch: open first, newest first. */
export async function listSupply(): Promise<Supply[]> {
  return queryPg<Supply>(`${SUPPLY_SELECT} order by supply.status = 'closed', supply.observed_on desc nulls last, supply.seller`);
}

/** Unified sell-side availability; matching remains separate from this read model. */
export async function listSupplyFeed(): Promise<SupplyFeedRow[]> {
  return queryPg<SupplyFeedRow>("select * from crm_bulk_listing_supply_feed order by seen desc nulls last, kind, title, id");
}

export async function getSupply(id: string): Promise<Supply | null> {
  const [row] = await queryPg<Supply>(`${SUPPLY_SELECT} where supply.id = $1`, [id]);
  return row ?? null;
}

export async function closeSupply(id: string, reason: SupplyClosedReason): Promise<Supply | null> {
  const rows = await queryPg(
    "update crm_bulk_supply set status = 'closed', closed_reason = $2, updated_at = now() where id = $1 returning id",
    [id, reason],
  );
  return rows.length ? getSupply(id) : null;
}

/** Reopens a closed batch; the next matching pass finds its buyers again. */
export async function reopenSupply(id: string): Promise<Supply | null> {
  const rows = await queryPg(
    // Closing dropped its suggestions; clearing the hash has the next matching pass judge it again.
    "update crm_bulk_supply set status = 'open', closed_reason = null, match_hash = null, updated_at = now() where id = $1 returning id",
    [id],
  );
  return rows.length ? getSupply(id) : null;
}

/** "Not a fit": hides one buyer for this batch; it stays hidden after re-matching. */
export async function hideSupplyFit(id: string, demandId: string): Promise<Supply | null> {
  const rows = await queryPg(
    "update crm_bulk_trade_supply_matches set hidden = true where supply_id = $1 and demand_id = $2 returning supply_id",
    [id, demandId],
  );
  return rows.length ? getSupply(id) : null;
}

/** The latest supply-matching pass, for the "Matched 08:00" line. */
export async function lastSupplyMatchRun(): Promise<{ at: string; status: "running" | "ok" | "failed" } | null> {
  const [row] = await queryPg<{ at: string; status: "running" | "ok" | "failed" }>(
    `select coalesce(finished_at, started_at) as at, status
     from crm_bulk_trade_check_runs where kind = 'supply_match' order by started_at desc limit 1`,
  );
  return row ?? null;
}
