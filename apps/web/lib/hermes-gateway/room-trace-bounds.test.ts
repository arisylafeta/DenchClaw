import { it, expect, vi } from 'vitest';
import { conversationKey } from '../hermes-conversations';
vi.mock('../hermes-native', () => ({ authorizeNativeConversation:vi.fn(async()=>({access:{visibility:'team'},version:1})), readRoomMemberConversation:vi.fn(), readConversation: vi.fn(), nativeFetch: vi.fn() }));
import { authorizeNativeConversation, readConversation } from '../hermes-native';
const actor={id:"user",email:"user@example.test",displayName:"User"};
import { readRoomTrace } from './room-trace';
it('omits probes exceeding the history cap', async () => {
  vi.mocked(readConversation).mockRejectedValueOnce(Error('Trace probe cap exceeded'));
  expect(await readRoomTrace(conversationKey('group', 'capped'), 'a', 't', actor)).toBeNull();
  expect(readConversation).toHaveBeenLastCalledWith(conversationKey('group', 'capped'), 0, 200,actor);
});
it('rejects a completed trace probe if its room was revoked during the read', async () => {
  vi.mocked(readConversation).mockImplementationOnce(async () => {
    vi.mocked(authorizeNativeConversation).mockRejectedValueOnce(Object.assign(new Error('not_found'), { status: 404 }));
    return { conversation: { participants: [] }, messages: [] } as unknown as Awaited<ReturnType<typeof readConversation>>;
  });
  await expect(readRoomTrace(conversationKey('group', 'revoked-probe'), 'a', 't', actor)).rejects.toMatchObject({ status: 404 });
});
it('runs at most two summary probes per room and coalesces pending history beyond TTL', async () => {
  let finish!: (value: Awaited<ReturnType<typeof readConversation>>) => void;
  vi.mocked(readConversation).mockClear();
  vi.mocked(readConversation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const key = conversationKey('group', 'concurrent');
  vi.useFakeTimers();
  const first = readRoomTrace(key, 'a', 't1', actor);
  await vi.advanceTimersByTimeAsync(6000);
  const second = readRoomTrace(key, 'b', 't2', actor);
  const third = readRoomTrace(key, 'c', 't3', actor);
  expect(await third).toBeNull();
  expect(readConversation).toHaveBeenCalledTimes(1);
  finish({ conversation: { participants: [] }, messages: [] } as unknown as Awaited<ReturnType<typeof readConversation>>);
  expect(await first).toBeNull(); expect(await second).toBeNull();
  vi.useRealTimers();
});
