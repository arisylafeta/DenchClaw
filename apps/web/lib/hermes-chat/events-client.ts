import type { GatewayEvent } from './events'
import type { GatewayChatSnapshot } from './snapshot'

export type ConnectionState = 'connected' | 'reconnecting' | 'lost'
export interface RequestEvent { key: string; id: string | number; method: 'approval' | 'clarify'; params: Record<string, unknown>; replayed?: boolean }
export interface EventsCallbacks {
  snapshot(value: GatewayChatSnapshot): void
  event(value: GatewayEvent): void
  request(value: RequestEvent): void
  error(message: string): void
  connection(state: ConnectionState): void
  resync?(): void
  /** The server removed this user's access. Purge everything held for the key; no further frames arrive. */
  revoked?(): void
}
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
  readonly readyState: number
}
export type EventSourceConstructor = new (url: string) => EventSourceLike
class SubscriptionError extends Error { constructor(readonly status: number) { super(`Gateway subscriptions failed (${status})`) } }
/** One multiplexed stream per browser tab. Removing a view never interrupts its run. */
export class HermesEventsClient {
  private source: EventSourceLike | null = null
  private connectionId: string | null = null
  private listeners = new Map<string, Set<EventsCallbacks>>()
  private subscribed = new Set<string>()
  private gatewayState: ConnectionState = 'reconnecting'
  private syncing: Promise<void> = Promise.resolve()
  private subscriptionIds = new Map<string, string>()
  private hydrating = new Set<string>()
  /** Keys whose access was withdrawn: every frame is dropped and nothing re-adds them until a view subscribes again. */
  private revoked = new Set<string>()
  private nextSubscription = 0
  constructor(private readonly Source: EventSourceConstructor, private readonly request: typeof fetch = (...args) => fetch(...args)) {}
  subscribe(key: string, callbacks: EventsCallbacks): () => void {
    let listeners = this.listeners.get(key)
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners) }
    listeners.add(callbacks)
    this.revoked.delete(key)
    if (listeners.size === 1) this.subscriptionIds.set(key, String(++this.nextSubscription))
    this.hydrating.add(key)
    callbacks.resync?.()
    callbacks.connection(this.gatewayState)
    if (!this.source) this.connect()
    else if (this.source.readyState === 2) this.resubscribe(key)
    else this.sync()
    return () => {
      listeners.delete(callbacks)
      if (!listeners.size) { this.listeners.delete(key); this.revoked.delete(key) }
      this.sync()
    }
  }
  resubscribe(key: string): void {
    if (this.revoked.has(key) || (this.hydrating.has(key) && this.source?.readyState !== 2)) return
    this.hydrating.add(key)
    this.subscriptionIds.set(key, String(++this.nextSubscription))
    for (const listener of this.listeners.get(key) ?? []) listener.resync?.()
    if (this.source?.readyState === 2) {
      this.source.close()
      this.source = null
      this.connectionId = null
      this.connect()
      return
    }
    this.syncing = this.syncing.then(async () => {
      if (!this.connectionId || !this.listeners.has(key)) return
      await this.post({ connectionId: this.connectionId, remove: [key], add: [] })
      this.subscribed.delete(key)
    }).catch(error => this.report(String(error)))
    this.sync()
  }
  private each(callback: (listener: EventsCallbacks) => void): void { for (const listeners of this.listeners.values()) for (const listener of listeners) callback(listener) }
  private report(message: string): void { this.each(listener => listener.error(message)) }
  private revoke(key: string): void {
    const listeners = this.listeners.get(key)
    if (!listeners) return
    this.revoked.add(key); this.hydrating.delete(key); this.subscribed.delete(key)
    // Snapshots issued under the old grant can no longer match.
    this.subscriptionIds.set(key, String(++this.nextSubscription))
    for (const listener of [...listeners]) listener.revoked?.()
  }
  /** Drops the key list from the URL so one inaccessible key cannot close the stream; keys are then added one by one. */
  private recover(): void {
    this.source?.close()
    this.source = null; this.connectionId = null; this.subscribed.clear()
    this.connect(false)
  }
  private connect(withKeys = true): void {
    const keys = withKeys ? [...this.listeners.keys()].filter(key => !this.revoked.has(key)) : []
    this.subscribed = new Set(keys)
    const subscriptionIds = Object.fromEntries(keys.map(key => [key, this.subscriptionIds.get(key)]))
    const source = this.source = new this.Source(`/api/hermes/events?keys=${encodeURIComponent(keys.join(','))}&subscriptionIds=${encodeURIComponent(JSON.stringify(subscriptionIds))}`)
    source.addEventListener('access-revoked', event => {
      try {
        if (source !== this.source) return
        const { key } = JSON.parse(event.data)
        if (typeof key === 'string') this.revoke(key)
      } catch (error) { this.report(`Invalid gateway event: ${String(error)}`) }
    })
    for (const type of ['snapshot', 'gw', 'request'] as const) source.addEventListener(type, event => {
      try {
        if (source !== this.source) return
        const value = JSON.parse(event.data)
        if (this.revoked.has(value.key)) return
        if (type === 'snapshot') {
          if (value.subscriptionId !== undefined && value.subscriptionId !== this.subscriptionIds.get(value.key)) return
          this.hydrating.delete(value.key)
        }
        for (const listener of this.listeners.get(value.key) ?? []) {
          if (type === 'snapshot') listener.snapshot(value)
          else if (type === 'gw') listener.event(value)
          else listener.request(value)
        }
      } catch (error) { this.report(`Invalid gateway event: ${String(error)}`) }
    })
    source.addEventListener('gateway', event => {
      try {
        const state = JSON.parse(event.data).state as ConnectionState
        if (!['connected', 'reconnecting', 'lost'].includes(state)) return
        this.gatewayState = state
        this.each(listener => listener.connection(state))
      } catch (error) { this.report(String(error)) }
    })
    source.addEventListener('resync', event => {
      try {
        const { key, subscriptionId } = JSON.parse(event.data)
        if (this.revoked.has(key) || (subscriptionId !== undefined && subscriptionId !== this.subscriptionIds.get(key))) return
        this.hydrating.add(key)
        for (const listener of this.listeners.get(key) ?? []) listener.resync?.()
      } catch (error) { this.report(String(error)) }
    })
    source.addEventListener('connection', event => {
      try {
        this.connectionId = JSON.parse(event.data).connectionId
        // Automatic reconnect uses the original URL; reconcile its key set with current visible views.
        this.subscribed = new Set(keys)
        const stale = keys.filter(key => this.listeners.has(key) && subscriptionIds[key] !== this.subscriptionIds.get(key))
        if (stale.length) {
          this.syncing = this.syncing.then(async () => {
            await this.post({ connectionId: this.connectionId, remove: stale, add: [] })
            for (const key of stale) this.subscribed.delete(key)
          }).catch(error => this.report(String(error)))
        }
        this.sync()
      } catch (error) { this.report(String(error)) }
    })
    source.addEventListener('error', event => {
      if (event.data) {
        let message = event.data
        try { message = JSON.parse(event.data).error } catch { /* Report the raw frame. */ }
        // The server closes the stream when a listed key is inaccessible; reconnecting with the same URL would loop.
        if (message === 'not_found' && source === this.source) this.recover()
        else this.report(message)
      }
      else {
        this.connectionId = null
        this.gatewayState = source.readyState === 2 ? 'lost' : 'reconnecting'
        this.each(listener => listener.connection(this.gatewayState))
      }
    })
  }
  private async post(body: unknown): Promise<void> {
    const response = await this.request('/api/hermes/events/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new SubscriptionError(response.status)
  }
  /** Applies a batch. The server authorizes additions as a whole, so a 404 is retried per key to find which grant is gone. */
  private async apply(connectionId: string, add: string[], remove: string[]): Promise<void> {
    const ids = (keys: string[]) => Object.fromEntries(keys.map(key => [key, this.subscriptionIds.get(key)]))
    const settle = (added: string[], removed: string[]) => {
      if (connectionId !== this.connectionId) return
      for (const key of added) if (!this.revoked.has(key)) this.subscribed.add(key)
      for (const key of removed) this.subscribed.delete(key)
    }
    try { await this.post({ connectionId, add, remove, subscriptionIds: ids(add) }); settle(add, remove); return }
    catch (error) { if (!(error instanceof SubscriptionError) || error.status !== 404 || !add.length) throw error }
    if (remove.length) { await this.post({ connectionId, add: [], remove }); settle([], remove) }
    for (const key of add) {
      try { await this.post({ connectionId, add: [key], remove: [], subscriptionIds: ids([key]) }); settle([key], []) }
      catch (error) { if (error instanceof SubscriptionError && error.status === 404) this.revoke(key); else throw error }
    }
  }
  private sync(): void {
    this.syncing = this.syncing.then(async () => {
      const connectionId = this.connectionId
      if (!connectionId) return
      const add = [...this.listeners.keys()].filter(key => !this.subscribed.has(key) && !this.revoked.has(key))
      const remove = [...this.subscribed].filter(key => !this.listeners.has(key))
      if (!add.length && !remove.length) return
      await this.apply(connectionId, add, remove)
    }).catch(error => this.report(String(error)))
  }
  close(): void {
    this.source?.close(); this.source = null; this.connectionId = null
    this.listeners.clear(); this.subscribed.clear(); this.subscriptionIds.clear(); this.hydrating.clear(); this.revoked.clear()
  }
}
let singleton: HermesEventsClient | undefined
export function getHermesEventsClient(): HermesEventsClient { return singleton ??= new HermesEventsClient(EventSource as unknown as EventSourceConstructor) }
/** Ends the shared stream and its subscriptions, if any were opened. Use when the signed-in account changes. */
export function closeHermesEventsClient(): void { singleton?.close(); singleton = undefined }
