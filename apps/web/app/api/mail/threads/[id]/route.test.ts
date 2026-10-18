import { beforeEach, expect, it, vi } from 'vitest';
const { currentUser, readMailThread } = vi.hoisted(() => ({ currentUser: vi.fn(), readMailThread: vi.fn() }));
vi.mock('@/lib/auth', () => ({ currentUser }));
vi.mock('@/lib/crm-postgres/mail', () => ({ readMailThread }));
import { GET } from './route';
beforeEach(() => vi.resetAllMocks());
it('returns HTML on each thread message and binds the authenticated owner', async () => {
  currentUser.mockResolvedValue({ id: 'owner' });
  const thread = { thread_id: 'thread', messages: [{ id: 'message', body_text: 'Plain alternative', body_html: '<p>HTML content</p>' }] };
  readMailThread.mockResolvedValue(thread);
  const response = await GET(new Request('http://localhost/api/mail/threads/thread?crmOnly=true'), { params: Promise.resolve({ id: 'thread' }) });
  expect(readMailThread).toHaveBeenCalledWith('thread', 'owner', true);
  expect(await response.json()).toEqual(thread);
});
it('rejects anonymous thread reads before querying', async () => {
  currentUser.mockResolvedValue(null);
  expect((await GET(new Request('http://localhost/api/mail/threads/thread'), { params: Promise.resolve({ id: 'thread' }) })).status).toBe(401);
  expect(readMailThread).not.toHaveBeenCalled();
});
