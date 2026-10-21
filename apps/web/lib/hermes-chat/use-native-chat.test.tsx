// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
class FakeSource {
  static instance: FakeSource
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  readyState = 1
  constructor(readonly url: string) { FakeSource.instance = this }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent) }) }
}
const snapshot = (key: string, text: string) => ({ key, conversation: { id: key, profile: 'alpha', title: key, working: false }, messages: [{ id: `${key}-row`, role: 'assistant', text }], running: false, generation: 1, seq: 0, pendingRequests: [] })
beforeEach(() => {
  vi.stubGlobal('EventSource', FakeSource)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
})
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals() })
describe('native controller', () => {
  it.each(['steered', 'redirected', 'queued'])('handles the unwrapped prompt JSON status %s', async status => {
    vi.mocked(fetch).mockImplementation(async url => Response.json(String(url).endsWith('/prompt') ? { status } : {}))
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    const running = { ...snapshot('first', 'history'), running: true, inflight: { user: 'Start', assistant: '', streaming: true } }
    FakeSource.instance.emit('snapshot', running)
    await act(() => result.current.send({ text: 'Change direction' }))
    const user = result.current.state.messages.find(message => message.segments.some(segment => segment.type === 'text' && segment.text === 'Change direction'))!
    // A steer waits in the queue until the agent reads it; only a redirect lands in the transcript at once.
    expect(result.current.queuedMessageIds).toEqual(status === 'redirected' ? [] : [user.id])
    expect(user.pending).toBe(status !== 'redirected')
    expect(Boolean(user.steerPending)).toBe(status === 'steered')
    expect(result.current.queuedMessages.map(item => item.steer)).toEqual(status === 'redirected' ? [] : [status === 'steered'])
    if (status === 'queued') {
      FakeSource.instance.emit('snapshot', { ...running, seq: 1, inflight: { user: 'Change direction', assistant: '', streaming: true } })
      expect(result.current.queuedMessageIds).toEqual([])
    } else if (status === 'redirected') expect(result.current.state.streamId).toBeNull()
  })

  it('discards old-session snapshots and never interrupts when switching or hiding', async () => {
    const { result, rerender } = renderHook(({ key, enabled }) => useNativeHermesChat({ conversationKey: key, enabled }), { initialProps: { key: 'first', enabled: true } })
    const source = FakeSource.instance
    source.emit('connection', { connectionId: 'one' })
    source.emit('snapshot', snapshot('first', 'first history'))
    expect(result.current.state.messages[0].segments[0]).toMatchObject({ text: 'first history' })
    rerender({ key: 'second', enabled: true })
    source.emit('snapshot', snapshot('first', 'stale history'))
    expect(result.current.state.messages).toEqual([])
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('subscriptions') && JSON.parse(String(init?.body)).add.includes('second'))).toBe(true))
    source.emit('snapshot', snapshot('second', 'second history'))
    expect(result.current.state.messages[0].segments[0]).toMatchObject({ text: 'second history' })
    rerender({ key: 'second', enabled: false })
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('subscriptions') && JSON.parse(String(init?.body)).remove.includes('second'))).toBe(true))
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/interrupt'))).toBe(false)
  })
  it.each([
    ['JSON 409', () => Response.json({ error: 'gateway_transport' }, { status: 409 }), 'gateway_transport'],
    ['proxy HTML 413', () => new Response('<html>\r\n<head><title>413 Request Entity Too Large</title></head></html>', { status: 413, headers: { 'Content-Type': 'text/html' } }), 'Gateway prompt failed (413)'],
  ])('sends a stable client id, surfaces a %s, and never retries a prompt', async (_label, failure, shown) => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? failure() : Response.json({}))
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    FakeSource.instance.emit('snapshot', snapshot('first', 'history'))
    await act(() => result.current.send({ text: '[Attached files: assets/pic.png]\n\npicture', html: '<p>picture</p>' }))
    const prompts = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))
    expect(prompts).toHaveLength(1)
    expect(JSON.parse(String(prompts[0][1]?.body))).toMatchObject({ clientMessageId: expect.any(String), html: '<p>picture</p>' })
    expect(result.current.state.messages.some(message => message.error === shown)).toBe(true)
    expect(result.current.state.busy).toBe(false)
  })
})
