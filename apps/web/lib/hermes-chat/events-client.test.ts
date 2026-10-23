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
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ connectionId: 'one', add: ['solo:second'], remove: [], subscriptionIds: { 'solo:second': '2' } })
    hide(); await settle()
    source.emit('error')
    expect(second.connection).toHaveBeenLastCalledWith('reconnecting')
    source.emit('connection', { connectionId: 'two' }); await settle()
    expect(JSON.parse(fetch.mock.calls.at(-1)![1]!.body as string)).toEqual({ connectionId: 'two', add: ['solo:second'], remove: ['solo:first'], subscriptionIds: { 'solo:second': '2' } })
    source.emit('snapshot', { key: 'solo:first' })
    expect(first.snapshot).not.toHaveBeenCalled()
    source.emit('snapshot', { key: 'solo:second', subscriptionId: '2' })
    client.resubscribe('solo:second'); await settle()
    const updates = fetch.mock.calls.slice(-2).map(call => JSON.parse(call[1]!.body as string))
    expect(updates).toEqual([{ connectionId: 'two', remove: ['solo:second'], add: [] }, { connectionId: 'two', add: ['solo:second'], remove: [], subscriptionIds: { 'solo:second': '3' } }])
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

it.each([['gateway', 'connection'], ['connection', 'gateway']])('keeps gateway health separate from SSE identity in %j order', (first, second) => {
  const client = new HermesEventsClient(FakeSource)
  const listener = callbacks()
  client.subscribe('a', listener)
  const source = FakeSource.instances.at(-1)!
  for (const event of [first, second]) source.emit(event, event === 'gateway' ? { state: 'lost' } : { connectionId: 'id' })
  expect(listener.connection).toHaveBeenLastCalledWith('lost')
  client.close()
})

it('coalesces resubscriptions and rejects a snapshot from the preceding subscription', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
  const client = new HermesEventsClient(FakeSource, fetch)
  const listener = { ...callbacks(), resync: vi.fn() }
  client.subscribe('a', listener)
  const source = FakeSource.instances.at(-1)!
  const initialIds = JSON.parse(new URL(source.url, 'http://local').searchParams.get('subscriptionIds')!)
  source.emit('connection', { connectionId: 'id' })
  source.emit('snapshot', { key: 'a', subscriptionId: initialIds.a })
  expect(listener.snapshot).toHaveBeenCalledOnce()
  client.resubscribe('a')
  source.emit('request', { key: 'a', id: 'srq-between', method: 'clarify', params: { question: 'Which?' } })
  client.resubscribe('a')
  await settle()
  expect(fetch).toHaveBeenCalledTimes(2)
  const subscription = JSON.parse(String(fetch.mock.calls[1][1]?.body))
  expect(subscription.subscriptionIds.a).not.toBe(initialIds.a)
  source.emit('snapshot', { key: 'a', subscriptionId: initialIds.a })
  expect(listener.snapshot).toHaveBeenCalledOnce()
  expect(listener.request).toHaveBeenCalledOnce()
  source.emit('snapshot', { key: 'a', subscriptionId: subscription.subscriptionIds.a })
  expect(listener.snapshot).toHaveBeenCalledTimes(2)
  client.close()
})

describe('access revocation', () => {
  const body = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string)
  it('notifies the view, drops every later frame and never re-adds the key on sync or reconnect', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    const client = new HermesEventsClient(FakeSource, fetch)
    const revoked = { ...callbacks(), revoked: vi.fn() }, other = callbacks()
    client.subscribe('a', revoked); client.subscribe('b', other)
    const source = FakeSource.instances.at(-1)!
    source.emit('connection', { connectionId: 'one' }); await settle()
    source.emit('access-revoked', { key: 'a' })
    expect(revoked.revoked).toHaveBeenCalledOnce()
    expect(other.revoked).toBeUndefined()
    for (const [type, payload] of [['snapshot', { key: 'a' }], ['gw', { key: 'a', type: 'message.delta' }], ['request', { key: 'a', id: 'r', method: 'approval', params: {} }], ['resync', { key: 'a' }]] as const) source.emit(type, payload)
    expect(revoked.snapshot).not.toHaveBeenCalled(); expect(revoked.event).not.toHaveBeenCalled(); expect(revoked.request).not.toHaveBeenCalled()
    source.emit('snapshot', { key: 'b' })
    expect(other.snapshot).toHaveBeenCalledOnce()
    // A resubscribe, a new view on another key and a reconnect must not resurrect the grant.
    client.resubscribe('a'); client.subscribe('c', callbacks()); await settle()
    expect(fetch.mock.calls.flatMap(call => body(call).add ?? [])).not.toContain('a')
    source.emit('error'); source.readyState = 2
    client.resubscribe('c')
    const reopened = FakeSource.instances.at(-1)!
    expect(new URL(reopened.url, 'http://local').searchParams.get('keys')!.split(',')).not.toContain('a')
    // Opening the chat again is a fresh request that the server decides.
    client.subscribe('a', revoked); reopened.emit('connection', { connectionId: 'two' }); await settle()
    expect(body(fetch.mock.calls.at(-1)!).add).toContain('a')
    client.close()
  })
  it('finds the inaccessible key when the server rejects a batch with 404', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => JSON.parse(init!.body as string).add.includes('gone') ? new Response('{}', { status: 404 }) : new Response('{}'))
    const client = new HermesEventsClient(FakeSource, fetch)
    const kept = callbacks(), gone = { ...callbacks(), revoked: vi.fn() }, first = callbacks()
    client.subscribe('first', first)
    FakeSource.instances.at(-1)!.emit('connection', { connectionId: 'one' }); await settle()
    client.subscribe('kept', kept); client.subscribe('gone', gone); await settle()
    expect(gone.revoked).toHaveBeenCalledOnce()
    expect(kept.error).not.toHaveBeenCalled()
    const adds = fetch.mock.calls.map(call => body(call).add).filter((add: string[]) => add.length === 1)
    expect(adds).toContainEqual(['kept'])
    FakeSource.instances.at(-1)!.emit('snapshot', { key: 'kept' })
    expect(kept.snapshot).toHaveBeenCalledOnce()
    client.close()
  })
  it('reconnects without the key list when the server closes the stream with not_found', async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => JSON.parse(init!.body as string).add.includes('gone') ? new Response('{}', { status: 404 }) : new Response('{}'))
    const client = new HermesEventsClient(FakeSource, fetch)
    const gone = { ...callbacks(), revoked: vi.fn() }, kept = callbacks()
    client.subscribe('kept', kept); client.subscribe('gone', gone)
    const first = FakeSource.instances.at(-1)!
    first.emit('connection', { connectionId: 'one' })
    first.emit('error', { error: 'not_found' })
    expect(first.readyState).toBe(2)
    const second = FakeSource.instances.at(-1)!
    expect(second).not.toBe(first)
    expect(new URL(second.url, 'http://local').searchParams.get('keys')).toBe('')
    second.emit('connection', { connectionId: 'two' }); await settle()
    expect(gone.revoked).toHaveBeenCalledOnce()
    expect(kept.error).not.toHaveBeenCalled()
    client.close()
  })
})
