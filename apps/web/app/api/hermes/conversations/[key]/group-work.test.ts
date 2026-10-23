import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/auth',()=>({currentUser:async()=>({id:'user',email:'user@example.test',displayName:'User'})}));
import { conversationKey } from '@/lib/hermes-conversations';
const mocks = vi.hoisted(() => ({ backend: vi.fn(() => 'hermes'), state: vi.fn(), activity: vi.fn(), trace: vi.fn() }));
vi.mock('@/lib/agent-backend', () => ({ resolveAgentBackend: mocks.backend }));
vi.mock('@/lib/hermes-native', () => ({ authorizeNativeConversation:vi.fn(async()=>({access:{visibility:'team'},version:1})), groupRpc: mocks.state }));
vi.mock('@/lib/hermes-gateway/room-activity', () => ({ readRoomActivity: mocks.activity }));
vi.mock('@/lib/hermes-gateway/room-trace', () => ({ readRoomTrace: mocks.trace }));
import { GET as activity } from './activity/route';
import { GET as trace } from './trace/route';
const key = conversationKey('group', 'synthetic');
const context = { params: Promise.resolve({ key }) };
afterEach(() => vi.resetAllMocks());
describe('read-only group routes', () => {
  it('returns only a dedicated minimal DTO and no cache', async () => {
    mocks.backend.mockReturnValue('hermes');
    mocks.state.mockResolvedValue({ room: { room_id: 'synthetic' }, driver_status: { working: true, pending_actions: [{ kind: 'approval', member_id: 'a' }] } });
    mocks.activity.mockResolvedValue({ members: [{ memberId: 'a', running: true, approval: false, tool: { args: { secret: 'synthetic' } }, preview: 'synthetic', profile: 'private' }], degraded: true, driver: {} });
    const response = await activity(new Request('http://test/activity'), context);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ members: [{ memberId: 'a', running: true, approval: false }], degraded: true });
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith('groups.state', { room_id: 'synthetic' });
  });
  it('does not expose reasoning or tools in summary probes', async () => {
    mocks.backend.mockReturnValue('hermes');
    mocks.trace.mockResolvedValue({ startedAt: 1, completedAt: 2, steps: 1, work: [{ type: 'reasoning', text: 'synthetic' }] });
    const response = await trace(new Request('http://test/trace?member=a&turn=t&summary=1'), context);
    expect(await response.json()).toEqual({ trace: { startedAt: 1, completedAt: 2, steps: 1 } });
    const expanded = await trace(new Request('http://test/trace?member=a&turn=t'), context);
    expect(await expanded.json()).toMatchObject({ trace: { work: [{ text: 'synthetic' }] } });
  });
  it('rejects solo identities and missing turn coordinates before discovery', async () => {
    mocks.backend.mockReturnValue('hermes');
    expect((await activity(new Request('http://test/activity'), { params: Promise.resolve({ key: conversationKey('solo', 's', 'a') }) })).status).toBe(400);
    expect((await trace(new Request('http://test/trace'), context)).status).toBe(400);
    expect(mocks.activity).not.toHaveBeenCalled(); expect(mocks.trace).not.toHaveBeenCalled();
  });
});
