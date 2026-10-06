import { queryPg } from "../postgres";
import { isMetricKey, type MetricKey, type PulseWeek } from "../marketplace-pulse";

/** The last `count` weeks with numbers, oldest first, and when they were last collected. */
export async function listWeeks(count = 12): Promise<{ weeks: PulseWeek[]; collected_at: string | null }> {
  const rows = await queryPg<{ week_start: string; metric: string; value: string | null; collected_at: string }>(
    `select to_char(week_start, 'YYYY-MM-DD') as week_start, metric, value::text,
            to_char(collected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as collected_at
       from crm_metric_snapshots
      where week_start in (select distinct week_start from crm_metric_snapshots order by week_start desc limit $1)
      order by week_start`,
    [count],
  );
  const weeks = new Map<string, PulseWeek>();
  let collected: string | null = null;
  for (const row of rows) {
    if (!isMetricKey(row.metric)) continue;
    const week = weeks.get(row.week_start) ?? { week_start: row.week_start, values: {} };
    if (row.value !== null) week.values[row.metric] = Number(row.value);
    weeks.set(row.week_start, week);
    if (!collected || row.collected_at > collected) collected = row.collected_at;
  }
  return { weeks: [...weeks.values()], collected_at: collected };
}

export async function listTargets(): Promise<Partial<Record<MetricKey, number>>> {
  const rows = await queryPg<{ metric: string; weekly_target: string }>(
    "select metric, weekly_target::text from crm_metric_targets",
  );
  const targets: Partial<Record<MetricKey, number>> = {};
  for (const row of rows) if (isMetricKey(row.metric)) targets[row.metric] = Number(row.weekly_target);
  return targets;
}

/** Sets a weekly target, or clears it when the value is null. */
export async function setTarget(metric: MetricKey, value: number | null, userId: string): Promise<void> {
  if (value === null) {
    await queryPg("delete from crm_metric_targets where metric = $1", [metric]);
    return;
  }
  await queryPg(
    `insert into crm_metric_targets (metric, weekly_target, updated_at, updated_by) values ($1, $2, now(), $3)
     on conflict (metric) do update set weekly_target = excluded.weekly_target, updated_at = now(), updated_by = excluded.updated_by`,
    [metric, value, userId],
  );
}
