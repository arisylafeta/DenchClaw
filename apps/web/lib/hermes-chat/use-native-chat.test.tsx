// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
import { ownerAccess, readerAccess, viewerAccess } from './access-fixture'
class FakeSource {
  static instance: FakeSource
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  readyState = 1
  constructor(readonly url: string) { FakeSource.instance = this }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent) }) }
}
const snapshot = (key: string, text: string, access: unknown = ownerAccess) => ({ key, conversation: { id: key, profile: 'alpha', title: key, working: false, access }, messages: [{ id: `${key}-row`, role: 'assistant', text }], running: false, generation: 1, seq: 0, pendingRequests: [] })
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
  const called = (suffix: string) => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith(suffix))
  const pending = [{ id: 'req', method: 'approval', params: { command: 'rm' } }]
  it('purges transcript, history, requests and permissions on access-revoked, then ignores every later frame', async () => {
    const onRevoked = vi.fn()
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true, onRevoked }))
    const source = FakeSource.instance
    source.emit('snapshot', { ...snapshot('first', 'private words'), olderCursor: '9', pendingRequests: pending, html: [{ id: 'first-row', html: '<p>private words</p>' }] })
    expect(result.current.state.messages).toHaveLength(1)
    expect(result.current.state.pendingRequests).toHaveLength(1)
    source.emit('access-revoked', { key: 'first' })
    expect(onRevoked).toHaveBeenCalledWith('first')
    expect(result.current).toMatchObject({ revoked: true, access: null, olderCursor: null, tails: {} })
    expect(result.current.state.messages).toEqual([])
    expect(result.current.state.pendingRequests).toEqual([])
    expect(result.current.html.size).toBe(0)
    source.emit('snapshot', snapshot('first', 'resurrected'))
    source.emit('gw', { key: 'first', type: 'message.delta', generation: 1, seq: 5, payload: { text: 'late' } })
    source.emit('request', { key: 'first', id: 'late', method: 'clarify', params: {} })
    expect(result.current.state.messages).toEqual([])
    expect(result.current.state.pendingRequests).toEqual([])
    await act(() => result.current.send({ text: 'hello?' }))
    expect(called('/prompt')).toHaveLength(0)
  })
  it('drops history and prompt responses that settle after access was withdrawn', async () => {
    let release: (response: Response) => void = () => {}
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    FakeSource.instance.emit('snapshot', { ...snapshot('first', 'now'), olderCursor: '9' })
    vi.mocked(fetch).mockImplementation(() => new Promise<Response>(resolve => { release = resolve }))
    const earlier = result.current.loadEarlier()
    FakeSource.instance.emit('access-revoked', { key: 'first' })
    release(Response.json({ messages: [{ id: '1', role: 'user', text: 'old private row' }], olderCursor: null }))
    await act(() => earlier)
    expect(result.current.state.messages).toEqual([])
    expect(result.current.olderCursor).toBeNull()
  })
  it('treats a not_found command response as withdrawn access', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? Response.json({ error: 'not_found' }, { status: 404 }) : Response.json({}))
    const onRevoked = vi.fn()
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true, onRevoked }))
    FakeSource.instance.emit('snapshot', snapshot('first', 'history'))
    await act(() => result.current.send({ text: 'hi' }))
    expect(onRevoked).toHaveBeenCalledWith('first')
    expect(result.current.state.messages).toEqual([])
  })
  it('lets a collaborator write but not approve, and a read-only viewer do neither', async () => {
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    const approval = { id: 'req', kind: 'approval', payload: {} } as never
    FakeSource.instance.emit('snapshot', snapshot('first', 'history', viewerAccess))
    await act(() => expect(result.current.approve(approval, 'once')).rejects.toThrow('approver'))
    expect(called('/approval')).toHaveLength(0)
    await act(() => result.current.send({ text: 'allowed' }))
    expect(called('/prompt')).toHaveLength(1)
    FakeSource.instance.emit('snapshot', snapshot('first', 'history', readerAccess))
    expect(result.current.access).toEqual(readerAccess)
    await act(() => result.current.send({ text: 'denied' }))
    await act(() => result.current.steer('denied'))
    await act(() => result.current.interrupt())
    await act(() => expect(result.current.goalControl('goal.pause')).rejects.toThrow('permission'))
    await act(() => expect(result.current.setModel('m')).rejects.toThrow('permission'))
    await act(() => expect(result.current.answerClarify({ id: 'q' } as never, {})).rejects.toThrow('permission'))
    expect(called('/prompt')).toHaveLength(1)
    for (const suffix of ['/steer', '/interrupt', '/control', '/model', '/clarify']) expect(called(suffix)).toHaveLength(0)
  })
  it.each([
    ['missing', undefined],
    ['malformed', { visibility: 'team', ownerId: 'owner', canWrite: 'yes' }],
    ['unknown visibility', { ...ownerAccess, visibility: 'public' }],
  ])('fails closed on %s access metadata: no transcript, no commands', async (_label, access) => {
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    const unverified = snapshot('first', 'unverifiable')
    FakeSource.instance.emit('snapshot', { ...unverified, conversation: { ...unverified.conversation, access } })
    expect(result.current.access).toBeNull()
    expect(JSON.stringify(result.current.state.messages)).not.toContain('unverifiable')
    await act(() => result.current.send({ text: 'hi' }))
    expect(called('/prompt')).toHaveLength(0)
  })
})
