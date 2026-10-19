import { afterEach, it, expect, vi } from 'vitest';
import { discoverRoomActivity, readRoomActivity } from './room-activity';
import { HermesGatewayManager, type GatewaySocket } from './manager';
vi.mock('../hermes-native', () => ({ nativeFetch: vi.fn(async (_profile: string) => Response.json({ data: [] })) }));
const room = { room_id: 'synthetic', name: 'Test', updated_at: 1, members: ['a', 'b', 'c'].map(profile => ({ profile, member_id: profile })) };
const stored = async (profile: string) => [{ id: profile, title: 'Group: synthetic', source: 'bot_room' }];
const rows = room.members.map(m => ({ id: `runtime-${m.profile}`, session_key: m.profile, title: 'Group: synthetic', status: 'working', preview: 'PRIVATE' }));
class FakeSocket implements GatewaySocket {
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  methods: string[] = [];
  rows = rows;
  hold = false;
  replies: (() => void)[] = [];
  addEventListener(type: string, handler: (event: unknown) => void) { (this.listeners[type] ??= []).push(handler); }
  emit(type: string, event: unknown = {}) { this.listeners[type]?.forEach(h => h(event)); }
  receive(frame: unknown) { this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', ...frame as object }) }); }
  send(text: string) {
    const frame = JSON.parse(text); this.methods.push(frame.method);
    const reply = () => this.receive({ id: frame.id, result: { sessions: this.rows } });
    if (this.hold) this.replies.push(reply); else reply();
  }
  close() {}
}
const managers: HermesGatewayManager[] = [];
afterEach(() => { managers.forEach(m => m.shutdown()); managers.length = 0; vi.useRealTimers(); });
async function real() {
  const socket = new FakeSocket();
  const manager = new HermesGatewayManager({ discoveryOnly: true, url: 'ws://127.0.0.1/api/ws', tokenProvider: async () => 'synthetic', socketFactory: () => socket }); managers.push(manager);
  const connected = manager.connect();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  socket.emit('open'); socket.receive({ method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: 'e' } } });
  await connected; return { socket, manager };
}
it('real manager sends exactly active_list for three members and discloses only the DTO', async () => {
  const { socket, manager } = await real();
  const result = await discoverRoomActivity(room, manager, stored);
  expect(new Set(socket.methods)).toEqual(new Set(['session.active_list']));
  expect(result).toEqual({ degraded: false, members: room.members.map(m => ({ memberId: m.member_id, running: true })) });
  expect(Object.keys(result).sort()).toEqual(['degraded', 'members']);
  result.members.forEach(m => expect(Object.keys(m).sort()).toEqual(['memberId', 'running']));
});
it('rejects stored ids shared by different member profiles', async () => {
  const { manager } = await real();
  const result = await discoverRoomActivity(room, manager, async () => [{ id: 'a' }]);
  expect(result.degraded).toBe(true); expect(result.members.every(m => !m.running)).toBe(true);
});
it('rejects multiple live rows for one member and wrong titles', async () => {
  const { manager, socket } = await real(); socket.rows = [rows[0], rows[0], { ...rows[1], title: 'Other room' }];
  const result = await discoverRoomActivity(room, manager, stored);
  expect(result.degraded).toBe(true); expect(result.members.every(m => !m.running)).toBe(true);
});
it('maps working, waiting and idle without content', async () => {
  const { manager, socket } = await real(); socket.rows = rows.map((r, i) => ({ ...r, status: ['working', 'waiting', 'idle'][i] }));
  expect((await discoverRoomActivity(room, manager, stored)).members).toEqual([{ memberId: 'a', running: true }, { memberId: 'b', running: false, approval: true }, { memberId: 'c', running: false }]);
});
it('bounds member discovery to six', async () => {
  const { manager } = await real(); const lookup = vi.fn(async () => []);
  const result = await discoverRoomActivity({ ...room, members: Array.from({ length: 9 }, (_, i) => ({ profile: String(i), member_id: String(i) })) }, manager, lookup);
  expect(lookup).toHaveBeenCalledTimes(6); expect(result.degraded).toBe(true);
});
it('coalesces pending active_list past TTL and starts freshness on completion', async () => {
  const { manager, socket } = await real(); vi.useFakeTimers(); socket.hold = true;
  const first = readRoomActivity(room, manager); await vi.advanceTimersByTimeAsync(6000);
  const second = readRoomActivity(room, manager); expect(second).toBe(first); expect(socket.methods).toEqual(['session.active_list']);
  socket.replies.shift()!(); await first;
  await vi.advanceTimersByTimeAsync(4999); expect(readRoomActivity(room, manager)).toBe(first);
  await vi.advanceTimersByTimeAsync(1); socket.hold = false; await readRoomActivity(room, manager);
  expect(socket.methods).toEqual(['session.active_list', 'session.active_list']);
});
it('allows at most two room discoveries concurrently', async () => {
  const { manager, socket } = await real(); socket.hold = true;
  const pending = Array.from({ length: 4 }, (_, i) => discoverRoomActivity({ ...room, room_id: String(i) }, manager, stored));
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(socket.methods).toHaveLength(2);
  socket.hold = false; socket.replies.splice(0).forEach(r => r()); await Promise.all(pending);
  expect(socket.methods).toHaveLength(4);
});
