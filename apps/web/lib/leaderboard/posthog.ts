import 'server-only';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SCORING, type Activity } from './scoring';

async function configuration() {
  let fallback: Record<string, unknown> = {};
  if (!process.env.POSTHOG_HOST || !process.env.POSTHOG_PROJECT_ID || !process.env.POSTHOG_API_KEY) {
    try { fallback = JSON.parse(await readFile(join(homedir(), '.posthog/credentials.json'), 'utf8')); } catch { /* Environment-only installations need no local credential. */ }
  }
  const host = String(process.env.POSTHOG_HOST || fallback.host || '').replace(/\/$/, '');
  const project = String(process.env.POSTHOG_PROJECT_ID || fallback.env_id || '');
  const token = process.env.POSTHOG_API_KEY || fallback.token;
  if (!['https://us.posthog.com', 'https://eu.posthog.com', 'https://app.posthog.com'].includes(host) || !/^\d+$/.test(project) || typeof token !== 'string' || !token) throw new Error('PostHog configuration unavailable');
  return {host, project, token};
}
export async function runPostHogQuery(query: string): Promise<unknown[][]> {
  const {host, project, token} = await configuration();
  let response: Response;
  try { response = await fetch(`${host}/api/projects/${project}/query/`, {
    method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({query: {kind: 'HogQLQuery', query, filters: {filterTestAccounts: true}}}),
    signal: AbortSignal.timeout(90000), redirect: 'error', cache: 'no-store',
  }); } catch { throw new Error('PostHog connection failed'); }
  if (response.status !== 200) throw new Error(`PostHog query failed (${response.status})`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('PostHog response invalid'); }
  if (payload.error || payload.hasMore === true || payload.is_partial === true || payload.partial === true || payload.query_status === 'running' || !Array.isArray(payload.results) || !payload.results.every(Array.isArray)) throw new Error('PostHog response incomplete');
  return payload.results;
}
export async function getPostHogActivity(window: 7 | 30 | 90, authIds?: string[]): Promise<Activity[]> {
  const size = 200;
  if (authIds?.some(id => !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id))) throw new Error('Platform identity invalid');
  const actions = Object.keys(SCORING.weights);
  const rows: Activity[] = [];
  let cursor = '';
  for (;;) {
    const data = await runPostHogQuery(`SELECT distinct_id, any(properties.account_role), any(properties.account_status), count(), max(timestamp),
      uniqIf(properties.$session_id, timestamp >= now() - INTERVAL ${window} DAY AND properties.$session_id IS NOT NULL),
      uniqIf(toDate(timestamp), timestamp >= now() - INTERVAL ${window} DAY), countIf(timestamp >= now() - INTERVAL ${window} DAY),
      countIf(timestamp >= now() - INTERVAL 7 DAY), countIf(timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY),
      countIf(event IN ('listing_offer_submitted','listing_buy_now_submitted','auction_bid_submitted')),
      ${actions.map(event => `countIf(event = '${event}' AND timestamp >= now() - INTERVAL ${window} DAY)`).join(', ')}
      FROM events WHERE match(distinct_id, '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
      ${authIds ? `AND distinct_id IN (${authIds.length ? authIds.map(id => `'${id}'`).join(',') : "''"})` : 'AND properties.$is_identified = true'}
      ${cursor ? `AND distinct_id > '${cursor}'` : ''}
      AND event NOT IN ('$web_vitals', '$pageleave', '$autocapture') AND {filters}
      AND coalesce(toString(properties.is_bot), 'false') NOT IN ('true','1')
      AND coalesce(toString(properties.$virt_is_bot), 'false') NOT IN ('true','1')
      AND coalesce(toString(properties.analytics_test_cohort), 'false') NOT IN ('true','1')
      GROUP BY distinct_id ORDER BY distinct_id LIMIT ${size}`);
    for (const row of data) {
      if (row.length !== 11 + actions.length || typeof row[0] !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(row[0]) || row.slice(3,4).concat(row.slice(5)).some(n => !Number.isFinite(Number(n)) || Number(n) < 0)) throw new Error('PostHog aggregate invalid');
      const lastSeen = new Date(String(row[4]));
      if (!Number.isFinite(lastSeen.getTime())) throw new Error('PostHog timestamp invalid');
      rows.push({authUserId: row[0], role: row[1] ? String(row[1]) : null, accountStatus: row[2] ? String(row[2]) : null, totalEvents: Number(row[3]), lastSeen: lastSeen.toISOString(), sessions: Number(row[5]), activeDays: Number(row[6]), engagementScore: Number(row[7]), recentEvents: Number(row[8]), previousEvents: Number(row[9]), hasOffer: Number(row[10]) > 0, actions: actions.map((event, index) => ({event, count: Number(row[11 + index])})).filter(a => a.count > 0)});
    }
    if (data.length < size) break;
    cursor = rows[rows.length - 1].authUserId;
  }
  return rows;
}
export async function getPostHogHealth() {
  const start = Date.now();
  try { await runPostHogQuery('SELECT 1 LIMIT 1'); return {status: 'ok' as const, latency: Date.now() - start}; }
  catch (error) { return {status: 'failing' as const, latency: Date.now() - start, error: error instanceof Error ? error.message : 'PostHog unavailable'}; }
}
