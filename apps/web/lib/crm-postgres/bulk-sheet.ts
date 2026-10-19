import { queryPg } from "../postgres";
import { LIVE_STAGES, HOLD_STAGE } from "../bulk-trades";
import { demandRow, sortSheet, supplyRow, tradeRow, type SheetRow } from "../bulk-sheet";
import { listBulkTrades } from "./bulk-trades";

const WORKING_STAGES: readonly string[] = [...LIVE_STAGES, HOLD_STAGE];

/**
 * Every open requirement, open supplier offer and live trade, one row each. Closed, qualifying and
 * history demand, closed offers, finished trades and stock-family summaries are left out. Trades that
 * the supply feed also lists are read once, from the trades table. Status entries (created, closed) are
 * bookkeeping, not work, so they never count as progress or as the latest development.
 */
export async function listSheet(): Promise<SheetRow[]> {
  const [demand, supply, { trades }] = await Promise.all([
    queryPg<Parameters<typeof demandRow>[0]>(`
      select demand.id, demand.buyer, demand.company_id, demand.wants, demand.product_family,
        (select count(*)::int from crm_bulk_trade_demand_activity a where a.demand_id = demand.id and a.kind <> 'status') as activity_count,
        (select count(*)::int from crm_bulk_trade_buyers b where b.demand_id = demand.id) as linked_trades,
        latest.kind as latest_kind, latest.title as latest_title, latest.occurred_at::text as latest_at,
        to_char(greatest(demand.observed_on, demand.confirmed_on), 'YYYY-MM-DD') as asked_on, demand.updated_at::text
      from crm_bulk_trade_demand demand
      left join lateral (select a.kind, a.title, a.occurred_at from crm_bulk_trade_demand_activity a
        where a.demand_id = demand.id and a.kind <> 'status' order by a.occurred_at desc, a.id desc limit 1) latest on true
      where demand.status = 'open'`),
    queryPg<Parameters<typeof supplyRow>[0]>(`
      select supply.id, supply.seller, supply.company_id, supply.offers, supply.trade_kind, supply.source_kind,
        supply.source_label, to_char(supply.observed_on, 'YYYY-MM-DD') as observed_on, supply.updated_at::text
      from crm_bulk_trade_supply supply where supply.status = 'open'`),
    listBulkTrades(),
  ]);
  return sortSheet([
    ...demand.map(demandRow),
    ...supply.map(supplyRow),
    ...trades.filter((trade) => WORKING_STAGES.includes(trade.trade_stage)).map(tradeRow),
  ]);
}
