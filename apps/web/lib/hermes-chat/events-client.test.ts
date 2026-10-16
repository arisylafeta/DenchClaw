import { describe, expect, it, vi } from 'vitest'
import { HermesEventsClient, type EventsCallbacks } from './events-client'
class FakeSource {
  static instances: FakeSource[] = []
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  readyState = 1
  constructor(readonly url: string) { FakeSource.instances.push(this) }
  addEventListener(type: string, callback: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(callback) }
  close() { this.readyState = 2 }
  emit(type: string, data?: unknown) { for (const listener of this.listeners[type] ?? []) listener({ data: data === undefined ? undefined : JSON.stringify(data) } as MessageEvent) }
}
const callbacks = (): EventsCallbacks => ({ snapshot: vi.fn(), event: vi.fn(), request: vi.fn(), error: vi.fn(), connection: vi.fn() })
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
describe('tab-wide gateway event subscriptions', () => {
  it('shares one stream, unsubscribes hidden views and restores current keys after reconnect', async () => {
    FakeSource.instances = []
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    const client = new HermesEventsClient(FakeSource, fetch)
    const first = callbacks(), second = callbacks()
    const hide = client.subscribe('solo:first', first)
    const source = FakeSource.instances[0]
    source.emit('connection', { connectionId: 'one' })
    client.subscribe('solo:second', second)
    await settle()
    expect(FakeSource.instances).toHaveLength(1)
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ connectionId: 'one', add: ['solo:second'], remove: [] })
    hide(); await settle()
    source.emit('error')
    expect(second.connection).toHaveBeenLastCalledWith('reconnecting')
    source.emit('connection', { connectionId: 'two' }); await settle()
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({ connectionId: 'two', add: ['solo:second'], remove: ['solo:first'] })
    source.emit('snapshot', { key: 'solo:first' })
    expect(first.snapshot).not.toHaveBeenCalled()
    client.resubscribe('solo:second'); await settle()
    const updates = fetch.mock.calls.slice(-2).map(call => JSON.parse(call[1]!.body as string))
    expect(updates).toEqual([{ connectionId: 'two', remove: ['solo:second'], add: [] }, { connectionId: 'two', add: ['solo:second'], remove: [] }])
    client.close()
  })
  it('routes request and snapshot by key and surfaces protocol and subscription errors', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 409 }))
    const client = new HermesEventsClient(FakeSource, fetch)
    const a = callbacks(), b = callbacks()
    client.subscribe('a', a); client.subscribe('b', b)
    const source = FakeSource.instances.at(-1)!
    source.emit('connection', { connectionId: 'id' }); await settle()
    expect(a.error).toHaveBeenCalledWith('Error: Gateway subscriptions failed (409)')
    source.emit('request', { key: 'b', id: 'srq', method: 'clarify', params: {} })
    expect(b.request).toHaveBeenCalledOnce(); expect(a.request).not.toHaveBeenCalled()
    source.emit('error', { error: 'auth rejected' })
    expect(a.error).toHaveBeenLastCalledWith('auth rejected')
    client.close()
  })
})
