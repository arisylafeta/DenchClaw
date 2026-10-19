import { resolveAgentBackend } from '@/lib/agent-backend';
import { parseConversationKey } from '@/lib/hermes-conversations';
import { readRoomTrace } from '@/lib/hermes-gateway/room-trace';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Authentication is enforced by middleware, exactly like the sibling conversation route.
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  if (resolveAgentBackend() !== 'hermes') return Response.json({ error: 'Hermes is not enabled' }, { status: 404 });
  try {
    const key = (await context.params).key;
    const identity = parseConversationKey(key);
    if (identity.kind !== 'group') return Response.json({ error: 'Group required' }, { status: 400 });
    const query = new URL(req.url).searchParams;
    const member = query.get('member'); const turn = query.get('turn');
    if (!member || !turn || member.length > 256 || turn.length > 256) return Response.json({ error: 'Invalid turn' }, { status: 400 });
    const trace = await readRoomTrace(key, member, turn);
    return Response.json({ trace: trace && query.get('summary') === '1' ? { startedAt: trace.startedAt, completedAt: trace.completedAt, steps: trace.steps } : trace }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not load group trace' }, { status: 502 }); }
}
