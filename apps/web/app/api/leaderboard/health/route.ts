import { currentUser } from '@/lib/auth';
import { queryPg } from '@/lib/postgres';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const STALE_HOURS = 36;
export async function GET() {
  if (!await currentUser()) return Response.json({error: 'Unauthorized'}, {status: 401});
  if (process.env.CRM_DB_BACKEND !== 'postgres') return Response.json({status: 'failing', error: 'Leaderboard requires Postgres'}, {status: 503});
  const [row] = await queryPg<{as_of: string | Date | null}>('select max(as_of) as as_of from crm_user_activity_snapshots');
  if (!row?.as_of) return Response.json({status: 'failing', error: 'No activity snapshot yet'}, {status: 503});
  const ageHours = (Date.now() - new Date(row.as_of).getTime()) / 3_600_000;
  return Response.json({status: ageHours > STALE_HOURS ? 'stale' : 'ok', asOf: new Date(row.as_of).toISOString(), ageHours: Math.round(ageHours * 10) / 10});
}
