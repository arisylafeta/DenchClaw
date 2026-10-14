import { currentUser } from '@/lib/auth';
import { getLeaderboard } from '@/lib/leaderboard/query';
import { SEGMENTS } from '@/lib/leaderboard/scoring';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  if (!await currentUser()) return Response.json({error: 'Unauthorized'}, {status: 401});
  if (process.env.CRM_DB_BACKEND !== 'postgres') return Response.json({source: 'error', error: 'Leaderboard requires Postgres', asOf: new Date().toISOString()}, {status: 503});
  const p = new URL(request.url).searchParams;
  const window = Number(p.get('window') ?? 30);
  const role = p.get('role') || undefined, segment = p.get('segment') || undefined;
  const limit = Number(p.get('limit') ?? 50), offset = Number(p.get('offset') ?? 0);
  const inCrm = p.get('inCrm');
  const sort = p.get('sort') || 'score';
  if ((window !== 7 && window !== 30 && window !== 90) || (role && !['buyer','supplier','recycler'].includes(role)) || (segment && !SEGMENTS.some(s => s === segment)) || !Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isInteger(offset) || offset < 0 || (inCrm !== null && !['true','false'].includes(inCrm)) || !['score','person','company','role','activeDays','lastSeen','topActions','intentScore'].includes(sort.replace(/^-/, ''))) return Response.json({error: 'Invalid leaderboard filters'}, {status: 400});
  const result = await getLeaderboard({window, role, segment, q: p.get('q') || undefined, inCrm: inCrm === null ? undefined : inCrm === 'true', noOffer: p.get('noOffer') === 'true', sort, limit, offset});
  return Response.json(result, {status: result.source === 'error' ? 503 : 200});
}
