import 'server-only';
import { queryPg } from '../postgres';
import { getPostHogActivity } from './posthog';
import { assignSegment, scoreActivity, SEGMENTS, type Activity, type Segment } from './scoring';
export type LeaderboardRow = {
  authUserId: string; personId: string | null; name: string | null; email: string | null; company: string | null;
  role: string | null; accountStatus: string | null; score: number; intentScore: number; engagementScore: number;
  sessions: number; activeDays: number; lastSeen: string | null; segment: Segment;
  topActions: {event: string; count: number}[]; inCrm: boolean; reviewStatus: string;
  emailOptedOut: boolean; hasOffer: boolean;
};
export type LeaderboardOptions = {window: 7 | 30 | 90; role?: string; segment?: string; q?: string; inCrm?: boolean; noOffer?: boolean; sort?: string; limit: number; offset: number};
export type LeaderboardResult = {rows: LeaderboardRow[]; total: number; asOf: string; source: 'ok' | 'error'; error?: string; linkPending?: boolean; counts: Record<Segment, number>};
type Link = {auth_user_id: string; person_id: string | null; name: string | null; email: string | null; company: string | null; account_role: string | null; account_status: string | null; auth_created_at: string | Date | null; review_status: string; email_opted_out: boolean | null};
const cache = new Map<number, {expires: number; asOf: string; activity: Activity[]}>();
const inflight = new Map<number, Promise<{expires: number; asOf: string; activity: Activity[]}>>();
async function activityFor(window: 7 | 30 | 90, authIds?: string[]) {
  const cached = cache.get(window);
  if (cached && cached.expires > Date.now()) return cached;
  let pending = inflight.get(window);
  if (!pending) {
    pending = getPostHogActivity(window, authIds).then(activity => {
      const value = {activity, asOf: new Date().toISOString(), expires: Date.now() + 900000}; cache.set(window, value); return value;
    }).finally(() => inflight.delete(window));
    inflight.set(window, pending);
  }
  return pending;
}
export function filterLeaderboard(rows: LeaderboardRow[], options: LeaderboardOptions) {
  const search = options.q?.trim().toLocaleLowerCase();
  const filtered = rows.filter(row => (!options.role || row.role === options.role) && (!search || [row.name, row.email, row.company].some(value => value?.toLocaleLowerCase().includes(search))) && (options.inCrm === undefined || row.inCrm === options.inCrm) && (!options.noOffer || !row.hasOffer));
  const counts = Object.fromEntries(SEGMENTS.map(segment => [segment, filtered.filter(row => row.segment === segment).length])) as Record<Segment, number>;
  const selected = filtered.filter(row => !options.segment || row.segment === options.segment);
  const sort = options.sort ?? 'score';
  const ascending = sort.startsWith('-');
  const key = sort.replace(/^-/, '');
  const value = (row: LeaderboardRow): string | number => {
    switch (key) {
      case 'person': return row.name ?? row.email ?? row.authUserId;
      case 'company': return row.company ?? '';
      case 'role': return row.role ?? '';
      case 'activeDays': return row.activeDays;
      case 'lastSeen': return row.lastSeen ? Date.parse(row.lastSeen) : 0;
      case 'intentScore': return row.intentScore;
      case 'topActions': return row.topActions.reduce((sum, a) => sum + a.count, 0);
      default: return row.score;
    }
  };
  selected.sort((a, b) => {
    const av = value(a), bv = value(b);
    const comparison = typeof av === 'number' && typeof bv === 'number' ? bv - av : String(av).localeCompare(String(bv));
    return (ascending ? -comparison : comparison) || b.engagementScore - a.engagementScore || a.authUserId.localeCompare(b.authUserId);
  });
  return {rows: selected.slice(options.offset, options.offset + options.limit), total: selected.length, counts};
}
export async function getLeaderboard(options: LeaderboardOptions): Promise<LeaderboardResult> {
  const counts = Object.fromEntries(SEGMENTS.map(s => [s, 0])) as Record<Segment, number>;
  try {
    let links: Link[] = [], linkPending = false;
    try { links = await queryPg<Link>(`select a.auth_user_id, a.person_id, p.full_name as name, coalesce(p.email,a.email) as email,
      c.name as company, a.account_role, a.account_status, a.auth_created_at, a.review_status, p.email_opted_out
      from crm_platform_accounts a left join crm_people p on p.id = a.person_id left join crm_companies c on c.id = p.company_id`); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === '42P01') linkPending = true; else throw new Error('CRM account links unavailable'); }
    const snapshot = await activityFor(options.window, linkPending ? undefined : links.map(link => link.auth_user_id));
    const activity = new Map(snapshot.activity.map(a => [a.authUserId, a]));
    const identities = new Map(links.map(link => [link.auth_user_id, link]));
    const ids = new Set([...activity.keys(), ...identities.keys()]);
    const now = Date.parse(snapshot.asOf);
    const rows = [...ids].map(authUserId => {
      const observed = activity.get(authUserId), link = identities.get(authUserId);
      return {authUserId, personId: link?.person_id ?? null, name: link?.name ?? null, email: link?.email ?? null, company: link?.company ?? null,
        role: link?.account_role ?? observed?.role ?? null, accountStatus: link?.account_status ?? observed?.accountStatus ?? null,
        ...(observed ? scoreActivity(observed, now) : {score: 0, intentScore: 0, engagementScore: 0}),
        sessions: observed?.sessions ?? 0, activeDays: observed?.activeDays ?? 0, lastSeen: observed?.lastSeen ?? null,
        segment: assignSegment(observed, link?.auth_created_at ? new Date(link.auth_created_at).toISOString() : null, now),
        topActions: [...(observed?.actions ?? [])].sort((a,b) => b.count-a.count), inCrm: !!link?.person_id,
        reviewStatus: linkPending ? 'link_pending' : link?.review_status ?? 'needs_review', emailOptedOut: !!link?.email_opted_out, hasOffer: observed?.hasOffer ?? false};
    });
    return {...filterLeaderboard(rows, options), asOf: snapshot.asOf, source: 'ok', linkPending};
  } catch (error) { return {rows: [], total: 0, counts, asOf: new Date().toISOString(), source: 'error', error: error instanceof Error ? error.message : 'Leaderboard unavailable'}; }
}
