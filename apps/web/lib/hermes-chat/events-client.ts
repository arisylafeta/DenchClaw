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
}
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  close(): void
  readonly readyState: number
}
export type EventSourceConstructor = new (url: string) => EventSourceLike
/** One multiplexed stream per browser tab. Removing a view never interrupts its run. */
export class HermesEventsClient {
  private source: EventSourceLike | null = null
  private connectionId: string | null = null
  private listeners = new Map<string, Set<EventsCallbacks>>()
  private subscribed = new Set<string>()
  private syncing: Promise<void> = Promise.resolve()
  constructor(private readonly Source: EventSourceConstructor, private readonly request: typeof fetch = (...args) => fetch(...args)) {}
  subscribe(key: string, callbacks: EventsCallbacks): () => void {
    let listeners = this.listeners.get(key)
    if (!listeners) { listeners = new Set(); this.listeners.set(key, listeners) }
    listeners.add(callbacks)
    callbacks.connection(this.connectionId ? 'connected' : 'reconnecting')
    if (!this.source) this.connect()
    else if (this.source.readyState === 2) this.resubscribe(key)
    else this.sync()
    return () => {
      listeners.delete(callbacks)
      if (!listeners.size) this.listeners.delete(key)
      this.sync()
    }
  }
  resubscribe(key: string): void {
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
  private connect(): void {
    const keys = [...this.listeners.keys()]
    this.subscribed = new Set(keys)
    const source = this.source = new this.Source(`/api/hermes/events?keys=${encodeURIComponent(keys.join(','))}`)
    for (const type of ['snapshot', 'gw', 'request'] as const) source.addEventListener(type, event => {
      try {
        const value = JSON.parse(event.data)
        for (const listener of this.listeners.get(value.key) ?? []) {
          if (type === 'snapshot') listener.snapshot(value)
          else if (type === 'gw') listener.event(value)
          else listener.request(value)
        }
      } catch (error) { this.report(`Invalid gateway event: ${String(error)}`) }
    })
    source.addEventListener('connection', event => {
      try {
        this.connectionId = JSON.parse(event.data).connectionId
        // Automatic reconnect uses the original URL; reconcile its key set with current visible views.
        this.subscribed = new Set(keys)
        this.each(listener => listener.connection('connected'))
        this.sync()
      } catch (error) { this.report(String(error)) }
    })
    source.addEventListener('error', event => {
      if (event.data) { try { this.report(JSON.parse(event.data).error) } catch { this.report(event.data) } }
      else {
        this.connectionId = null
        this.each(listener => listener.connection(source.readyState === 2 ? 'lost' : 'reconnecting'))
      }
    })
  }
  private async post(body: unknown): Promise<void> {
    const response = await this.request('/api/hermes/events/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`Gateway subscriptions failed (${response.status})`)
  }
  private sync(): void {
    this.syncing = this.syncing.then(async () => {
      const connectionId = this.connectionId
      if (!connectionId) return
      const add = [...this.listeners.keys()].filter(key => !this.subscribed.has(key))
      const remove = [...this.subscribed].filter(key => !this.listeners.has(key))
      if (!add.length && !remove.length) return
      await this.post({ connectionId, add, remove })
      if (connectionId !== this.connectionId) return
      for (const key of add) this.subscribed.add(key)
      for (const key of remove) this.subscribed.delete(key)
    }).catch(error => this.report(String(error)))
  }
  close(): void { this.source?.close(); this.source = null; this.connectionId = null; this.listeners.clear(); this.subscribed.clear() }
}
let singleton: HermesEventsClient | undefined
export function getHermesEventsClient(): HermesEventsClient { return singleton ??= new HermesEventsClient(EventSource as unknown as EventSourceConstructor) }
