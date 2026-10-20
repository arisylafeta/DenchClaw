import { queryPg } from "../postgres";
import { LIVE_STAGES, HOLD_STAGE } from "../bulk-trades";
import { demandRow, sortSheet, supplyRow, tradeRow, type SheetRow } from "../bulk-sheet";

const WORKING_STAGES: string[] = [...LIVE_STAGES, HOLD_STAGE];

/**
 * Every open requirement, open supplier offer and live trade, one row each. Closed, qualifying and
 * history demand, closed offers, finished trades and stock-family summaries are left out. Trades that
 * the supply feed also lists are read once, from the trades table. Status entries (created, closed) are
 * bookkeeping, not work, so they never count as progress or as the latest development.
 */
export async function listSheet(): Promise<SheetRow[]> {
  const [demand, supply, trades] = await Promise.all([
    queryPg<Parameters<typeof demandRow>[0]>(`
      select demand.id, demand.buyer, demand.company_id, demand.wants, demand.product_family,
        bulk_demand_score(demand.fee_eur, demand.price_basis, demand.reputation, greatest(demand.observed_on, demand.confirmed_on)) as score,
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
    // Only the columns a row shows, and only live trades: the full trade list also totals mail, bids and
    // proposals for every trade ever made, which the sheet never displays.
    queryPg<Parameters<typeof tradeRow>[0]>(`
      select lot.id, lot.title, lot.origin, bulk_trade_seller_display(lot.seller_ref, lot.seller_name) as seller_name,
        (nullif(trim(lot.seller_name), '') is not null or lot.seller_ref is not null) as has_seller,
        exists(select 1 from crm_bulk_trade_buyers buyer where buyer.lot_id = lot.id) as has_buyer,
        lot.trade_stage, lot.trade_kind, lot.next_step, to_char(lot.next_step_due, 'YYYY-MM-DD') as next_step_due,
        lot.waiting_on, to_char(lot.waiting_since, 'YYYY-MM-DD') as waiting_since, owner.display_name as owner_name,
        to_char(greatest(lot.last_touched, (select max(event.occurred_at)::date from crm_bulk_trade_events event where event.lot_id = lot.id),
          (select max(buyer.last_touch_on) from crm_bulk_trade_buyers buyer where buyer.lot_id = lot.id)), 'YYYY-MM-DD') as last_touched,
        to_char(lot.hold_until, 'YYYY-MM-DD') as hold_until, lot.updated_at::text
      from crm_bulk_trade_lots lot left join crm_users owner on owner.id = lot.owner_user_id
      where lot.trade_stage = any($1::text[])`, [WORKING_STAGES]),
  ]);
  return sortSheet([
    ...demand.map(demandRow),
    ...supply.map(supplyRow),
    ...trades.map(tradeRow),
  ]);
}
