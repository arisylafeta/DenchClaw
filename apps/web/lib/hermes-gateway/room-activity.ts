import type { ToolSegment } from '../hermes-chat/reducer';
import { nativeFetch, type Room } from '../hermes-native';
import { getHermesGatewayManager, type HermesGatewayManager } from './manager';
export interface RoomMemberActivity { memberId: string; profile: string; name: string; running: boolean; startedAt?: number; status: string; tool?: ToolSegment }
const tools = new WeakMap<HermesGatewayManager, Map<string, { started: number; generation: number; seq: number; tool?: ToolSegment }>>();
/** Only use events observed after ownership verification and within the same timed turn.
 * Mid-tool attachment has no trustworthy start frame, so it stays Thinking until the next tool. */
export function observedRoomTool(manager: HermesGatewayManager, key: string, started: number): ToolSegment | undefined {
  let sessions = tools.get(manager);
  if (!sessions) { sessions = new Map(); tools.set(manager, sessions); }
  const old = sessions.get(key);
  const replay = manager.eventsSince(key, old?.generation, old?.seq);
  const current = { started, generation: replay.generation, seq: replay.latestSeq, tool: old?.tool };
  if (!started || !old || old.started !== started || replay.truncated || old.generation !== replay.generation) current.tool = undefined;
  else for (const event of replay.events) {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (event.type === 'message.complete' || event.type === 'message.start') current.tool = undefined;
    if (event.type === 'tool.complete' && payload?.tool_id === current.tool?.toolId) current.tool = undefined;
    if (event.type === 'tool.start' && typeof payload?.name === 'string' && typeof payload.tool_id === 'string') {
      current.tool = { type: 'tool', id: payload.tool_id, toolId: payload.tool_id, name: payload.name,
        args: payload.args && typeof payload.args === 'object' ? payload.args as Record<string, unknown> : {}, status: 'running', startedAt: Date.now() };
    }
  }
  if (sessions.size >= 128 && !sessions.has(key)) sessions.delete(sessions.keys().next().value!);
  sessions.set(key, current);
  return current.tool;
}
export interface RoomActivity { members: RoomMemberActivity[]; degraded: boolean }
export interface RoomSession { id: string; title?: string; source?: string }
export async function roomSessions(profile: string, roomId: string): Promise<RoomSession[]> {
  const page = await (await nativeFetch(profile, `/api/sessions?title=${encodeURIComponent(`Group: ${roomId}`)}&include_hidden=true&limit=100`)).json();
  return (page.data ?? []).filter((row: RoomSession) => row.title === `Group: ${roomId}` && row.source === 'bot_room');
}
/** No resume/create/submit calls: attaching is additive and preserves the driver's close_on_disconnect=false. */
export async function discoverRoomActivity(room: Room, manager: HermesGatewayManager, lookup = roomSessions): Promise<RoomActivity> {
  const result: RoomActivity = { members: [], degraded: room.members.length > 6 };
  try {
    const live = await manager.call('session.active_list', {});
    await Promise.all(room.members.slice(0, 6).map(async member => {
      try {
        const stored = await lookup(member.profile, room.room_id);
        const candidates = live.sessions.filter(row => stored.some(s => s.id === row.session_key));
        // Avoid guessing if a profile has several matching live sessions.
        if (candidates.length > 1) { result.degraded = true; return; }
        for (const candidate of candidates) {
          const key = manager.retainSession(member.profile, candidate.session_key);
          const snapshot = await manager.attachLive(key, candidate.id);
          if (!snapshot) { result.degraded = true; continue; }
          if (!snapshot.running) continue;
          const started = snapshot.turn_started_at ?? snapshot.info?.turn_started_at;
          const tool = observedRoomTool(manager, key, started ?? 0);
          result.members.push({ memberId: member.member_id, profile: member.profile, name: member.display_name || member.handle || member.profile,
            running: true, status: 'Thinking', ...(tool ? { tool } : {}), ...(started && started > 0 ? { startedAt: started * 1000 } : {}) });
        }
      } catch { result.degraded = true; }
    }));
  } catch { result.degraded = true; }
  result.members.sort((a, b) => room.members.findIndex(m => m.member_id === a.memberId) - room.members.findIndex(m => m.member_id === b.memberId));
  return result;
}
const cache = new WeakMap<HermesGatewayManager, Map<string, { until: number; pending: Promise<RoomActivity> }>>();
export function readRoomActivity(room: Room): Promise<RoomActivity> {
  const manager = getHermesGatewayManager();
  let rooms = cache.get(manager);
  if (!rooms) { rooms = new Map(); cache.set(manager, rooms); }
  const old = rooms.get(room.room_id);
  if (old && old.until > Date.now()) return old.pending;
  const pending = discoverRoomActivity(room, manager);
  if (rooms.size >= 64) rooms.delete(rooms.keys().next().value!);
  rooms.set(room.room_id, { until: Date.now() + 5000, pending });
  return pending;
}
