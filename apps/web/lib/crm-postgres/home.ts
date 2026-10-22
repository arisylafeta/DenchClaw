import { queryPg } from "../postgres";
import type { BulkRows } from "../home-bulk";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/** When Marketplace Pulse numbers were last written, across every row; null before the first run. */
export async function lastCollectedAt(): Promise<string | null> {
  const rows = await queryPg<{ collected_at: string | null }>(
    `select to_char(max(collected_at) at time zone 'UTC', ${ISO}) as collected_at from crm_metric_snapshots`,
  );
  return rows[0]?.collected_at ?? null;
}

/** Bulk trade rows for Home, read only. Counting happens in lib/home-bulk.ts. */
export async function bulkRows(): Promise<BulkRows> {
  const [lots, demand, bids, buyers] = await Promise.all([
    queryPg<BulkRows["lots"][number]>(
      // A stage change is logged as trade_updated with changes.trade_stage = [from, to], or as the
      // starting stage of trade_created.
      `select lot.id, lot.title, lot.trade_stage, lot.value,
              to_char(lot.last_touched, 'YYYY-MM-DD') as last_touched,
              to_char(lot.latest_activity_at at time zone 'UTC', ${ISO}) as latest_activity_at,
              to_char(lot.updated_at at time zone 'UTC', ${ISO}) as updated_at,
              (select to_char(max(event.occurred_at) at time zone 'UTC', ${ISO})
                 from crm_bulk_trade_events event
                where event.lot_id = lot.id
                  and ((event.kind = 'trade_updated' and jsonb_typeof(event.changes->'trade_stage') = 'array'
                        and event.changes->'trade_stage'->>1 = lot.trade_stage)
                    or (event.kind = 'trade_created' and event.changes->>'trade_stage' = lot.trade_stage))) as stage_event_at
         from crm_bulk_trade_lots lot`,
    ),
    queryPg<BulkRows["demand"][number]>(
      "select status, max_price::float as max_price from crm_bulk_trade_demand where status in ('open', 'qualifying')",
    ),
    queryPg<BulkRows["bids"][number]>(
      `select to_char(created_at at time zone 'UTC', ${ISO}) as created_at, firmness from crm_bulk_trade_bids`,
    ),
    queryPg<BulkRows["buyers"][number]>("select lot_id, status from crm_bulk_trade_buyers"),
  ]);
  return { lots, demand, bids, buyers };
}
