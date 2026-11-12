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

/** Bulk trade rows for Home, read only, from the live Trades Preview tables. Counting happens in lib/home-bulk.ts. */
export async function bulkRows(): Promise<BulkRows> {
  const [listings, offers] = await Promise.all([
    queryPg<BulkRows["listings"][number]>(
      `select l.id, l.kind, l.status, l.party,
              coalesce(nullif(btrim(l.context->>'listing_title'), ''), nullif(btrim(l.spec->>'listing_title'), ''), l.summary) as title,
              l.spec->>'value_eur' as value_eur, l.spec->>'max_price' as max_price,
              (l.hold_until is not null and l.hold_until >= current_date) as on_hold,
              bulk_listing_deal_stage(l.id) as deal_stage,
              (select to_char(max(a.occurred_at) at time zone 'UTC', ${ISO}) from crm_bulk_listing_activity a
                where a.bulk_listing_id = l.id and a.kind in ('mail', 'outreach', 'quote', 'note', 'call', 'whatsapp')) as latest_touch_at
         from crm_bulk_listings l
        where l.status <> 'closed' or l.updated_at >= now() - interval '120 days'`,
    ),
    queryPg<BulkRows["offers"][number]>(
      `select bulk_listing_id, stage,
              to_char(created_at at time zone 'UTC', ${ISO}) as created_at,
              to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at,
              terms->>'firmness' as firmness, to_char(paid_on, 'YYYY-MM-DD') as paid_on, take_gbp
         from crm_bulk_offers
        where role = 'counterparty'`,
    ),
  ]);
  return { listings, offers };
}
