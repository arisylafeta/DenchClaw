import { it, expect, vi } from 'vitest';
import { conversationKey } from '../hermes-conversations';
vi.mock('../hermes-native', () => ({ readConversation: vi.fn(), nativeFetch: vi.fn() }));
import { readConversation } from '../hermes-native';
import { readRoomTrace } from './room-trace';
it('omits probes exceeding the history cap', async () => {
  vi.mocked(readConversation).mockRejectedValueOnce(Error('Trace probe cap exceeded'));
  expect(await readRoomTrace(conversationKey('group', 'capped'), 'a', 't')).toBeNull();
  expect(readConversation).toHaveBeenLastCalledWith(conversationKey('group', 'capped'), 0, 200);
});
it('runs at most two summary probes per room and coalesces pending history beyond TTL', async () => {
  let finish!: (value: Awaited<ReturnType<typeof readConversation>>) => void;
  vi.mocked(readConversation).mockClear();
  vi.mocked(readConversation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const key = conversationKey('group', 'concurrent');
  vi.useFakeTimers();
  const first = readRoomTrace(key, 'a', 't1');
  await vi.advanceTimersByTimeAsync(6000);
  const second = readRoomTrace(key, 'b', 't2');
  const third = readRoomTrace(key, 'c', 't3');
  expect(await third).toBeNull();
  expect(readConversation).toHaveBeenCalledTimes(1);
  finish({ conversation: { participants: [] }, messages: [] } as unknown as Awaited<ReturnType<typeof readConversation>>);
  expect(await first).toBeNull(); expect(await second).toBeNull();
  vi.useRealTimers();
});
