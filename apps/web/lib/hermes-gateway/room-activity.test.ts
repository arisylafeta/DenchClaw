import { describe, it, expect, vi } from 'vitest';
import { discoverRoomActivity, observedRoomTool } from './room-activity';
import type { HermesGatewayManager } from './manager';
const room = { room_id: 'synthetic', name: 'Test', updated_at: 1, members: ['a', 'b'].map(profile => ({ profile, member_id: profile })) };
function fake(fail = false) {
  const call = vi.fn(async (method: string) => { if (method !== 'session.active_list') throw Error('write RPC forbidden'); return { sessions: [{ id: 'runtime', session_key: 'same', status: 'working' }] }; });
  const retainSession = vi.fn((profile: string) => profile);
  const attachLive = vi.fn(async (profile: string) => !fail && profile === 'a' ? { running: true, turn_started_at: 10 } : undefined);
  return { call, retainSession, attachLive, eventsSince: vi.fn(() => ({ generation: 0, latestSeq: 0, events: [], truncated: false })) };
}
const stored = vi.fn(async () => [{ id: 'same', title: 'Group: synthetic', source: 'bot_room' }]);
describe('read-only room discovery', () => {
  it('uses only newly observed tools from the verified timed turn and resets at turn boundaries', () => {
    let replay = { generation: 0, latestSeq: 1, truncated: false, events: [] as Array<Record<string, unknown>> };
    const manager = { eventsSince: vi.fn(() => replay) } as unknown as HermesGatewayManager;
    expect(observedRoomTool(manager, 'profile:id', 10)).toBeUndefined();
    replay = { ...replay, latestSeq: 2, events: [{ type: 'tool.start', payload: { tool_id: 't', name: 'read_file', args: { path: 'fixture' } } }] };
    expect(observedRoomTool(manager, 'profile:id', 10)?.name).toBe('read_file');
    replay = { ...replay, latestSeq: 3, events: [{ type: 'tool.complete', payload: { tool_id: 't' } }] };
    expect(observedRoomTool(manager, 'profile:id', 10)).toBeUndefined();
    replay = { ...replay, latestSeq: 4, events: [{ type: 'tool.start', payload: { tool_id: 't2', name: 'terminal' } }] };
    expect(observedRoomTool(manager, 'profile:id', 10)?.name).toBe('terminal');
    expect(observedRoomTool(manager, 'profile:id', 20)).toBeUndefined();
    replay = { ...replay, latestSeq: 5, truncated: true };
    expect(observedRoomTool(manager, 'profile:id', 20)).toBeUndefined();
  });
  it('requires ownership verification even for colliding stored ids', async () => {
    const manager = fake();
    const result = await discoverRoomActivity(room, manager as unknown as HermesGatewayManager, stored);
    expect(result.members.map(m => m.memberId)).toEqual(['a']);
    expect(result.degraded).toBe(true);
    expect(manager.call.mock.calls.map(c => c[0])).toEqual(['session.active_list']);
    expect(manager.attachLive.mock.calls).toEqual([['a', 'runtime'], ['b', 'runtime']]);
  });
  it('degrades when attachment fails', async () => {
    expect(await discoverRoomActivity(room, fake(true) as unknown as HermesGatewayManager, stored)).toEqual({ members: [], degraded: true });
  });
  it('bounds profile discovery to six members', async () => {
    const lookup = vi.fn(async () => []);
    const result = await discoverRoomActivity({ ...room, members: Array.from({ length: 9 }, (_, i) => ({ profile: String(i), member_id: String(i) })) }, fake() as unknown as HermesGatewayManager, lookup);
    expect(lookup).toHaveBeenCalledTimes(6);
    expect(result.degraded).toBe(true);
  });
  it('degrades if the gateway is unavailable', async () => {
    const manager = fake(); manager.call.mockRejectedValueOnce(Error('offline'));
    expect(await discoverRoomActivity(room, manager as unknown as HermesGatewayManager, stored)).toEqual({ members: [], degraded: true });
  });
});
