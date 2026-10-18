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
  it('sends images and a stable client id, surfaces a 409, and never retries a prompt', async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? Response.json({ error: 'gateway_transport' }, { status: 409 }) : Response.json({}))
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'first', enabled: true }))
    FakeSource.instance.emit('snapshot', snapshot('first', 'history'))
    await act(() => result.current.send({ text: 'picture', images: [{ content: 'AAAA', mimeType: 'image/png', fileName: 'pic.png' }], html: '<p>picture</p>' }))
    const prompts = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))
    expect(prompts).toHaveLength(1)
    expect(JSON.parse(String(prompts[0][1]?.body))).toMatchObject({ clientMessageId: expect.any(String), html: '<p>picture</p>', images: [{ content: 'AAAA', mimeType: 'image/png', fileName: 'pic.png' }] })
    expect(result.current.state.messages.some(message => message.error === 'gateway_transport')).toBe(true)
    expect(result.current.state.busy).toBe(false)
  })
})
