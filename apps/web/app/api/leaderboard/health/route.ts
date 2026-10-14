import { currentUser } from '@/lib/auth';
import { getPostHogHealth } from '@/lib/leaderboard/posthog';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  if (!await currentUser()) return Response.json({error: 'Unauthorized'}, {status: 401});
  if (process.env.CRM_DB_BACKEND !== 'postgres') return Response.json({status: 'failing', error: 'Leaderboard requires Postgres'}, {status: 503});
  const result = await getPostHogHealth();
  return Response.json(result, {status: result.status === 'ok' ? 200 : 503});
}
