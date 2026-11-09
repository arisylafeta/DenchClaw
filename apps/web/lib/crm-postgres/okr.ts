import { queryPg } from "../postgres";
import type { BulkRows } from "../okr";

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS"Z"'`;

/** Bulk trade rows for the OKR viewer, read only. Counting happens in lib/okr.ts. */
export async function okrBulkRows(): Promise<BulkRows> {
  const [listings, offers, touches] = await Promise.all([
    queryPg<BulkRows["listings"][number]>(
      `select id, kind, status, closed_reason, to_char(created_at at time zone 'UTC', ${ISO}) as created_at
         from crm_bulk_listings`,
    ),
    queryPg<BulkRows["offers"][number]>(
      `select id, bulk_listing_id, stage,
              to_char(created_at at time zone 'UTC', ${ISO}) as created_at,
              to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at,
              to_char(last_touch_on, 'YYYY-MM-DD') as last_touch_on,
              terms->>'amount' as amount, terms->>'unit' as unit, terms->>'quantity' as quantity,
              terms->>'currency' as currency, data->>'take_gbp' as take_gbp
         from crm_bulk_offers
        where role = 'counterparty'`,
    ),
    queryPg<BulkRows["touches"][number]>(
      `select bulk_listing_id, to_char(occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from crm_bulk_listing_activity
        where kind in ('mail', 'outreach', 'quote', 'note', 'call', 'whatsapp')`,
    ),
  ]);
  return { listings, offers, touches };
}

export async function okrProgress(): Promise<Record<string, { percent: number; note: string; updated_at: string }>> {
  const rows = await queryPg<{ kr_key: string; percent: number; note: string; updated_at: string }>(
    `select kr_key, percent, note, to_char(updated_at at time zone 'UTC', ${ISO}) as updated_at from crm_okr_progress`,
  );
  return Object.fromEntries(rows.map((r) => [r.kr_key, { percent: r.percent, note: r.note, updated_at: r.updated_at }]));
}
