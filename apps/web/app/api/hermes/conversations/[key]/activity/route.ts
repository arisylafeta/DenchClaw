import { resolveAgentBackend } from '@/lib/agent-backend';
import { parseConversationKey } from '@/lib/hermes-conversations';
import { groupRpc, type RoomState } from '@/lib/hermes-native';
import { readRoomActivity } from '@/lib/hermes-gateway/room-activity';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Authentication is enforced by middleware, exactly like the sibling conversation route.
export async function GET(req: Request, context: { params: Promise<{ key: string }> }) {
  if (resolveAgentBackend() !== 'hermes') return Response.json({ error: 'Hermes is not enabled' }, { status: 404 });
  try {
    const key = (await context.params).key;
    const identity = parseConversationKey(key);
    if (identity.kind !== 'group') return Response.json({ error: 'Group required' }, { status: 400 });
    const state = await groupRpc<RoomState>('groups.state', { room_id: identity.id });
    const activity = await readRoomActivity(state.room);
    return Response.json({ members: activity.members.map(({ memberId, running, approval }) => ({ memberId, running, ...(approval === undefined ? {} : { approval }) })), degraded: activity.degraded }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Could not load group activity' }, { status: 502 }); }
}
