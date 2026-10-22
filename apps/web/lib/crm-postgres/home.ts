import { queryPg } from "../postgres";

/** When Marketplace Pulse numbers were last written, across every row; null before the first run. */
export async function lastCollectedAt(): Promise<string | null> {
  const rows = await queryPg<{ collected_at: string | null }>(
    `select to_char(max(collected_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as collected_at from crm_metric_snapshots`,
  );
  return rows[0]?.collected_at ?? null;
}
