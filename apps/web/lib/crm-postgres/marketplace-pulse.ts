import { randomUUID } from "node:crypto";
import { queryPg, withPgTransaction } from "../postgres";
import { isMetricKey, type Breakdown, type MetricKey, type PulseWeek, type Suggestion, type SuggestionStatus } from "../marketplace-pulse";
import type { Plan, PlanVersion } from "../marketplace-pulse-plan";

/** The last `count` weeks with numbers, oldest first, and when they were last collected. */
export async function listWeeks(count = 12): Promise<{ weeks: PulseWeek[]; collected_at: string | null }> {
  const rows = await queryPg<{ week_start: string; metric: string; value: string | null; collected_at: string }>(
    `select to_char(week_start, 'YYYY-MM-DD') as week_start, metric, value::text,
            to_char(collected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as collected_at
       from crm_metric_snapshots
      where dimension = ''
        and week_start in (select distinct week_start from crm_metric_snapshots order by week_start desc limit $1)
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

/** Breakdowns (channel, landing page, referrer, ordered funnel) for the last `count` weeks. */
export async function listBreakdowns(count = 12): Promise<Breakdown[]> {
  return queryPg<Breakdown>(
    `select to_char(week_start, 'YYYY-MM-DD') as week_start, metric, dimension, value::float as value
       from crm_metric_snapshots
      where dimension <> ''
        and week_start in (select distinct week_start from crm_metric_snapshots order by week_start desc limit $1)
      order by week_start, metric, dimension`,
    [count],
  );
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

/**
 * Puts a marketplace buyer in the CRM: finds them by email or adds them, tags them
 * marketplace-buyer, and subscribes them to Supply update unless they opted out.
 */
export async function addMarketplaceBuyer(email: string, name: string | null): Promise<{ person_id: string; subscribed: boolean; opted_out: boolean }> {
  return withPgTransaction(async (tx) => {
    const found = await tx.query<{ id: string; opted_out: boolean }>(
      "select id, coalesce(email_opted_out, false) as opted_out from crm_people where lower(email) = lower($1) order by created_at limit 1",
      [email],
    );
    let id = found.rows[0]?.id;
    if (!id) {
      id = randomUUID();
      await tx.query("insert into crm_people (id, email, full_name, tags) values ($1, $2, $3, array['marketplace-buyer'])", [id, email.toLowerCase(), name]);
    } else {
      await tx.query(
        `update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['marketplace-buyer'])), updated_at = now()
          where id = $1 and not (coalesce(tags, '{}') @> array['marketplace-buyer'])`,
        [id],
      );
    }
    if (!found.rows[0]?.opted_out) {
      // An existing Opted out row stays as it is.
      await tx.query(
        `insert into crm_subscriptions (person_id, list, status, since, how) values ($1, 'Supply update', 'Subscribed', current_date, 'Marketplace buyer')
         on conflict (person_id, list) do nothing`,
        [id],
      );
    }
    const sub = await tx.query<{ status: string }>("select status from crm_subscriptions where person_id = $1 and list = 'Supply update'", [id]);
    const subscribed = sub.rows[0]?.status === "Subscribed";
    if (subscribed) {
      await tx.query(
        `update crm_people set tags = array(select distinct unnest(coalesce(tags, '{}') || array['Supply Update'])), updated_at = now()
          where id = $1 and not (coalesce(tags, '{}') @> array['Supply Update'])`,
        [id],
      );
    }
    return { person_id: id, subscribed, opted_out: !subscribed };
  });
}

const SUGGESTION_COLUMNS = `id, to_char(batch, 'YYYY-MM-DD') as batch, title, evidence, action, metric, owner, status,
  to_char(before_week, 'YYYY-MM-DD') as before_week, before_value::float as before_value,
  to_char(status_changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as status_changed_at`;

/** New suggestions from the latest batch, everything in progress, and the last 60 days of finished ones. */
export async function listSuggestions(): Promise<Suggestion[]> {
  return queryPg<Suggestion>(
    `select ${SUGGESTION_COLUMNS} from crm_pulse_suggestions
      where (status = 'New' and batch = (select max(batch) from crm_pulse_suggestions))
         or status = 'Doing'
         or (status in ('Done', 'Dismissed') and status_changed_at > now() - interval '60 days')
      order by case status when 'Doing' then 0 when 'New' then 1 else 2 end, coalesce(status_changed_at, created_at) desc`,
  );
}

export async function setSuggestionStatus(id: string, status: SuggestionStatus, userId: string): Promise<Suggestion | null> {
  const rows = await queryPg<Suggestion>(
    `update crm_pulse_suggestions set status = $2, status_changed_at = now(), status_changed_by = $3
      where id = $1 returning ${SUGGESTION_COLUMNS}`,
    [id, status, userId],
  );
  return rows[0] ?? null;
}

const PLAN_COLUMNS = `p.id, p.plan, to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at,
  u.display_name as created_by_name`;

/** The latest plan, and the last 20 versions (newest first) without their contents. */
export async function listPlans(): Promise<{ plan: PlanVersion | null; versions: Omit<PlanVersion, "plan">[] }> {
  const rows = await queryPg<PlanVersion>(
    `select ${PLAN_COLUMNS} from crm_pulse_plans p left join crm_users u on u.id::text = p.created_by
      order by p.created_at desc, p.id desc limit 20`,
  );
  return { plan: rows[0] ?? null, versions: rows.map(({ plan: _plan, ...version }) => version) };
}

export async function getPlan(id: string): Promise<PlanVersion | null> {
  const rows = await queryPg<PlanVersion>(
    `select ${PLAN_COLUMNS} from crm_pulse_plans p left join crm_users u on u.id::text = p.created_by where p.id = $1`, [id]);
  return rows[0] ?? null;
}

/** Saves a plan as a new version; older versions stay as they were. */
export async function savePlan(plan: Plan, userId: string): Promise<PlanVersion> {
  const id = randomUUID();
  await queryPg("insert into crm_pulse_plans (id, plan, created_by) values ($1, $2, $3)", [id, JSON.stringify(plan), userId]);
  return (await getPlan(id))!;
}
