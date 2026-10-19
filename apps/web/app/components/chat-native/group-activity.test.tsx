// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { GroupWorkingBubbles, GroupWorkTrace, GroupActivity } from './group-activity';
const roster = ['alpha', 'beta'].map(profile => ({ profile, memberId: profile, name: profile }));
const activity = { degraded: false, members: roster.map(m => ({ memberId: m.memberId, running: true })) };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('stacks current members in roster order, replacing their bubbles as messages settle', () => {
  const { container, rerender } = render(<GroupWorkingBubbles working activity={{ ...activity, members: [...activity.members].reverse() }} roster={roster} />);
  expect([...container.querySelectorAll('[data-member-working]')].map(n => n.getAttribute('data-member-working'))).toEqual(['alpha', 'beta']);
  rerender(<GroupWorkingBubbles working activity={activity} roster={roster} settled={[{ memberId: 'alpha', createdAt: 2000 }]} />);
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  expect(container.querySelector('[data-member-working="beta"]')).not.toBeNull();
  rerender(<GroupWorkingBubbles working={false} activity={activity} roster={roster} />);
  expect(screen.queryByText('Thinking')).toBeNull();
});
it('shows a coarse bubble when discovery degrades, but never while idle', () => {
  const { rerender } = render(<GroupWorkingBubbles working activity={{ members: [], degraded: true }} roster={roster} />);
  expect(screen.getByText('Agents are working')).toBeInTheDocument();
  rerender(<GroupWorkingBubbles working={false} activity={{ members: [], degraded: true }} roster={roster} />);
  expect(screen.queryByText('Agents are working')).toBeNull();
});
it('replaces an approval member bubble with a neutral non-action line', () => {
  const { container } = render(<GroupWorkingBubbles working activity={activity} roster={roster} driver={{ pending_actions: [{ kind: 'approval', member_id: 'alpha' }] }} />);
  expect(screen.getByText('Waiting for approval: alpha')).toBeInTheDocument();
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  expect(container.querySelector('[data-member-working="beta"]')).not.toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows only generic working status, with client-observed elapsed', () => {
  render(<GroupWorkingBubbles working activity={activity} roster={roster} />);
  expect(screen.getAllByText('Working')).toHaveLength(2);
  expect(screen.getAllByTitle('since you opened this chat or since it started, whichever is later')).toHaveLength(2);
});
it('shows a second turn after a user message and a fresh running poll', () => {
  const { container, rerender } = render(<GroupWorkingBubbles working activity={activity} roster={roster} lastUser="user1" />);
  const settled = [{ memberId: 'alpha', createdAt: 2000 }];
  rerender(<GroupWorkingBubbles working activity={activity} roster={roster} settled={settled} lastUser="user1" />);
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  const lastPoll = { ...activity };
  rerender(<GroupWorkingBubbles working activity={lastPoll} roster={roster} settled={settled} lastUser="user1" />);
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  rerender(<GroupWorkingBubbles working activity={lastPoll} roster={roster} settled={settled} lastUser="user2" />);
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  rerender(<GroupWorkingBubbles working activity={{ ...activity }} roster={roster} settled={settled} lastUser="user2" />);
  expect(container.querySelector('[data-member-working="alpha"]')).not.toBeNull();
});
it('ignores old settlements on opening and revives after an observed idle transition', () => {
  const settled = [{ memberId: 'alpha', createdAt: 2000 }];
  const { container, rerender } = render(<GroupWorkingBubbles working activity={activity} roster={roster} settled={settled} />);
  expect(container.querySelector('[data-member-working="alpha"]')).not.toBeNull();
  const next = [{ memberId: 'alpha', createdAt: 3000 }];
  rerender(<GroupWorkingBubbles working activity={activity} roster={roster} settled={next} />);
  expect(container.querySelector('[data-member-working="alpha"]')).toBeNull();
  rerender(<GroupWorkingBubbles working activity={{ degraded: false, members: [{ memberId: 'alpha', running: false }] }} roster={roster} settled={next} />);
  rerender(<GroupWorkingBubbles working activity={{ ...activity }} roster={roster} settled={next} />);
  expect(container.querySelector('[data-member-working="alpha"]')).not.toBeNull();
});
it('keeps trace collapsed, loads full work only on click, and uses the solo work and folded tool UI', async () => {
  const summary = { startedAt: 1000, completedAt: 43000, steps: 1 };
  const trace = { ...summary, work: [{ type: 'reasoning', id: 'r', text: 'Synthetic reasoning', startedAt: 1000, completedAt: 2000 }, { type: 'tool', id: 't', toolId: 't', name: 'read_file', args: { path: 'fixture.txt' }, status: 'error', error: 'Synthetic failure', result: 'Synthetic failure', startedAt: 2000, completedAt: 4000 }] };
  const fetch = vi.fn(async (url: string) => Response.json({ trace: url.includes('summary=1') ? summary : trace })); vi.stubGlobal('fetch', fetch);
  const { container } = render(<GroupWorkTrace conversationKey="room" memberId="alpha" turnId="t1" />);
  const button = await screen.findByRole('button', { name: 'Worked 42s · 1 step' });
  expect(button).toHaveAttribute('aria-expanded', 'false'); expect(fetch).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Synthetic reasoning')).toBeNull();
  fireEvent.click(button);
  await screen.findByText('Synthetic reasoning');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('details[data-segment="work"]')).toHaveAttribute('open');
  expect(container.querySelector('[data-failed="true"]')).not.toBeNull();
  const toolDetail = container.querySelector('[data-tool-id="t"] details');
  expect(toolDetail).not.toBeNull(); expect(toolDetail).not.toHaveAttribute('open');
  fireEvent.click(button); expect(screen.queryByText('Synthetic reasoning')).toBeNull();
});
it('omits the chip when no reliable trace is available', async () => {
  const fetch = vi.fn(async () => Response.json({ trace: null })); vi.stubGlobal('fetch', fetch);
  render(<GroupWorkTrace conversationKey="room" memberId="alpha" turnId="passed" />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button')).toBeNull();
});
it('polls activity only while working and visible, never writes on unmount', async () => {
  vi.useFakeTimers(); const fetch = vi.fn(async (_url: string) => Response.json(activity)); vi.stubGlobal('fetch', fetch);
  const { rerender, unmount } = render(<GroupActivity conversationKey="room" working={false} roster={roster} />);
  expect(fetch).not.toHaveBeenCalled();
  rerender(<GroupActivity conversationKey="room" working roster={roster} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  rerender(<GroupActivity conversationKey="room" working roster={roster} visible={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  unmount(); expect(fetch.mock.calls.every(c => c.length === 1 && c[0].endsWith('/activity'))).toBe(true);
});
