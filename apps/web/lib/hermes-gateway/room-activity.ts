import { nativeFetch, type Room } from '../hermes-native';
import { HermesGatewayManager } from './manager';
import { BoundedReads, limitConcurrency } from './room-read-cache';
export interface RoomMemberActivity { memberId: string; running: boolean; approval?: boolean }
export interface RoomActivity { members: RoomMemberActivity[]; degraded: boolean }
export interface RoomSession { id: string; title?: string; source?: string }
export async function roomSessions(profile: string, roomId: string): Promise<RoomSession[]> {
  const page = await (await nativeFetch(profile, `/api/sessions?title=${encodeURIComponent(`Group: ${roomId}`)}&include_hidden=true&limit=100`)).json();
  if ((page.data?.length ?? 0) >= 100 || page.has_more) throw Error('Ambiguous room session discovery');
  return (page.data ?? []).filter((row: RoomSession) => row.title === `Group: ${roomId}` && row.source === 'bot_room');
}
const discovery = limitConcurrency(2);
/** active_list is the only viewer RPC. Never activate a transport, subscribe, or read previews. */
export function discoverRoomActivity(room: Room, manager: HermesGatewayManager, lookup = roomSessions): Promise<RoomActivity> {
  return discovery(async () => {
    const result: RoomActivity = { members: [], degraded: room.members.length > 6 };
    try {
      const live = await manager.call('session.active_list', {});
      const members = room.members.slice(0, 6);
      let lookupFailed = false;
      const stored = await Promise.all(members.map(async member => {
        try { return await lookup(member.profile, room.room_id); }
        catch { lookupFailed = true; result.degraded = true; return []; }
      }));
      for (const [i, member] of members.entries()) {
        const ids = stored[i].map(s => s.id);
        const collision = ids.some(id => stored.some((rows, j) => members[j].profile !== member.profile && rows.some(s => s.id === id)));
        const candidates = live.sessions.filter(row => ids.includes(row.session_key) && row.title === `Group: ${room.room_id}`);
        if (lookupFailed || room.members.length > 6 || collision || candidates.length > 1) { result.degraded = true; result.members.push({ memberId: member.member_id, running: false }); continue; }
        const status = String(candidates[0]?.status ?? '');
        // Hermes exposes only "waiting", not whether the pending request is approval or clarify.
        result.members.push({ memberId: member.member_id, running: status === 'working' || status === 'running', ...(status === 'waiting' ? { approval: true } : {}) });
      }
    } catch { result.degraded = true; }
    return result;
  });
}
const caches = new WeakMap<HermesGatewayManager, BoundedReads<RoomActivity>>();
const viewer = globalThis as typeof globalThis & { __hermesRoomViewer?: HermesGatewayManager };
function roomViewer() { return viewer.__hermesRoomViewer ??= new HermesGatewayManager({ discoveryOnly: true }); }
export function readRoomActivity(room: Room, manager = roomViewer()): Promise<RoomActivity> {
  let cache = caches.get(manager);
  if (!cache) { cache = new BoundedReads(64, 5000); caches.set(manager, cache); }
  return cache.read(JSON.stringify([room.room_id, room.members.map(m => [m.member_id, m.profile])]), () => discoverRoomActivity(room, manager));
}
