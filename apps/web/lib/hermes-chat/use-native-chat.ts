'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WorkspaceContext } from '../agent-message'
import type { HermesConversation } from '../hermes-conversations'
import { getHermesEventsClient, type ConnectionState } from './events-client'
import { applyLive, applySnapshot, beginHydration, initialReconcileState, markSteerPending, placeSteer, submitOptimistic, type ReconcileState } from './reconcile'
import { messageText, reduce, withNotice, type PendingRequest } from './reducer'
import { steerOwnText, type Notice } from './notice'
import { goalFromControl, type GoalAction, type GoalSnapshot } from './goal'
import { mapMessageHtml, type MessageHtmlRow } from './html-map'
import { stateFromSnapshot, type GatewayChatSnapshot } from './snapshot'
import type { SlashCompletion } from './slash-commands'
import { initialSubagents, isTerminalSubagent } from './subagents'

export interface NativePrompt { text: string; context?: WorkspaceContext; html?: string }
export interface NativeChatOptions { conversationKey?: string; enabled: boolean }
const context = { now: () => Date.now(), id: () => crypto.randomUUID() }
export interface NativeHermesChat {
  state: ReconcileState
  active: boolean
  subagents: ReconcileState['subagents']
  todos: ReconcileState['todos']
  tails: Record<string, string>
  connection: ConnectionState
  readOnly: { source: string } | null
  html: Map<string, string>
  queuedMessageIds: string[]
  /** Messages waiting for the running turn: queued prompts and steers Hermes has not read yet. */
  queuedMessages: { id: string; text: string; steer: boolean }[]
  /** The chat's standing goal (Hermes /goal), or null. */
  goal: GoalSnapshot | null
  goalControl(action: GoalAction, args?: { text?: string; index?: number }): Promise<Record<string, unknown>>
  olderCursor: string | null
  loadingEarlier: boolean
  loadEarlier(): Promise<void>
  setModel(model: string, provider?: string, confirm?: boolean): Promise<Record<string, unknown>>
  setReasoning(effort: string): Promise<Record<string, unknown>>
  setFast(enabled: boolean): Promise<Record<string, unknown>>
  completeSlash(text: string, signal?: AbortSignal): Promise<SlashCompletion>
  addNotice(notice: Notice): void
  executeSlash(command: string): Promise<Record<string, unknown>>
  send(prompt: NativePrompt): Promise<void>
  interrupt(): Promise<void>
  steer(text: string): Promise<void>
  approve(request: PendingRequest, choice: 'once' | 'session' | 'always' | 'deny'): Promise<void>
  answerClarify(request: PendingRequest, answers: Record<string, string | null>): Promise<void>
  subagentTail(id: string): Promise<void>
  subagentSteer(id: string, text: string): Promise<void>
  subagentInterrupt(id: string): Promise<void>
  retry(): Promise<void>
  branch(): Promise<HermesConversation | null>
}
export function useNativeHermesChat({ conversationKey, enabled }: NativeChatOptions): NativeHermesChat {
  const [state, setState] = useState(() => initialReconcileState(null, conversationKey))
  const current = useRef(state)
  const [connection, setConnection] = useState<ConnectionState>('reconnecting')
  const [readOnly, setReadOnly] = useState<{ source: string } | null>(null)
  const [tails, setTails] = useState<Record<string, string>>({})
  const [htmlRows, setHtmlRows] = useState<MessageHtmlRow[]>([])
  const optimisticHtml = useRef(new Map<string, string>())
  const queued = useRef(new Set<string>())
  const activeKey = useRef(conversationKey)
  const hydrationToken = useRef(0)
  const [olderCursor, setOlderCursor] = useState<string | null>(null)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const historyLoading = useRef(false)
  const earlierRows = useRef<GatewayChatSnapshot['messages']>([])
  const lastSnapshot = useRef<GatewayChatSnapshot | null>(null)
  activeKey.current = conversationKey
  const update = useCallback((fn: (previous: ReconcileState) => ReconcileState) => {
    current.current = fn(current.current)
    setState(current.current)
  }, [])
  const surface = useCallback((message: string) => update(previous => ({ ...previous, ...reduce(previous, { type: 'client.error', payload: { message } }, context) })), [update])
  const resync = useCallback(() => {
    if (!conversationKey || !enabled) return
    getHermesEventsClient().resubscribe(conversationKey)
  }, [conversationKey, enabled, update])
  useEffect(() => {
    if (current.current.key !== (conversationKey ?? null)) {
      setReadOnly(null); setTails({}); setHtmlRows([]); optimisticHtml.current.clear(); queued.current.clear()
      setOlderCursor(null); earlierRows.current = []; lastSnapshot.current = null
      update(previous => beginHydration(previous, conversationKey ?? null, conversationKey ?? null))
    }
    if (!enabled || !conversationKey) return
    update(previous => beginHydration(previous))
    hydrationToken.current = current.current.loadToken
    return getHermesEventsClient().subscribe(conversationKey, {
      snapshot(snapshot) {
        if (activeKey.current !== conversationKey) return
        update(previous => applySnapshot(previous, snapshot, hydrationToken.current, context))
        lastSnapshot.current = snapshot
        if (!earlierRows.current.length) setOlderCursor(snapshot.olderCursor ?? null)
        if (earlierRows.current.length) {
          const ids = new Set(current.current.messages.map(message => message.id))
          const earlier = stateFromSnapshot({ ...snapshot, messages: earlierRows.current, running: false, inflight: null, queued: null }, context).messages
          update(previous => ({ ...previous, messages: [...earlier.filter(message => !ids.has(message.id)), ...previous.messages] }))
        }
        if (snapshot.gateway) setConnection(snapshot.gateway === 'connected' ? 'connected' : 'lost')
        setHtmlRows(snapshot.html ?? [])
        const source = snapshot.conversation.source
        setReadOnly(source === 'cron' || source === 'webhook' ? { source } : null)
        if (!snapshot.running) queued.current.clear()
      },
      event(event) {
        if (activeKey.current !== conversationKey) return
        update(previous => applyLive(previous, [event], context))
        if (current.current.resyncRequired) resync()
        if (!current.current.busy) queued.current.clear()
        // A completed turn becomes durable; refresh its watermark rather than
        // retaining every delta forever (including while the panel is hidden).
        if (event.type === 'message.complete' || (event.type === 'error' && !current.current.busy)) resync()
      },
      request(request) {
        if (activeKey.current !== conversationKey) return
        update(previous => applyLive(previous, [{ type: request.method === 'approval' ? 'approval.request' : 'clarify.request', requestId: request.id, payload: request.params }], context))
      },
      error: surface,
      resync() {
        update(previous => beginHydration(previous))
        hydrationToken.current = current.current.loadToken
      },
      connection(state) {
        setConnection(previous => {
          if (state === 'connected' && previous !== 'connected' && !current.current.hydrating) resync()
          return state
        })
      },
    })
  }, [conversationKey, enabled, resync, surface, update])
  const post = useCallback(async (action: string, body: unknown): Promise<Record<string, unknown>> => {
    const key = conversationKey
    if (!key || !enabled) throw new Error('No active gateway conversation')
    if (connection === 'lost') throw new Error('Gateway disconnected')
    try {
      const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(key)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      // Proxy errors (413, 502) arrive as HTML; report the status instead of a JSON parse error.
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        if (result.error === 'automation_read_only' && activeKey.current === key) setReadOnly({ source: 'automation' })
        if (response.status === 503 && result.error === 'gateway_unavailable' && activeKey.current === key) setConnection('lost')
        if (result.error === 'gateway_unavailable') throw new Error('Gateway disconnected. Reconnect before sending another message.')
        if (response.status === 409 && result.error === 'sse_transport') throw new Error('This conversation uses the SSE transport and cannot accept gateway commands.')
        throw new Error(result.error || `Gateway ${action} failed (${response.status})`)
      }
      if (result.status === 'rejected' || result.found === false) {
        throw new Error(typeof result.reason === 'string' ? result.reason : `Gateway ${action} rejected: the target is no longer controllable`)
      }
      return result
    } catch (error) {
      // Slash errors have their own command-labelled transcript notice.
      if (activeKey.current === key && action !== 'slash-execute') surface(error instanceof Error ? error.message : String(error))
      throw error
    }
  }, [conversationKey, enabled, surface, connection])
  const send = useCallback(async (prompt: NativePrompt) => {
    if (connection === 'lost') { surface('Gateway disconnected'); return }
    if (readOnly) { surface('automation_read_only'); return }
    const key = conversationKey
    const clientMessageId = crypto.randomUUID()
    const wasBusy = current.current.busy
    const submittedAt = Date.now()
    const loadToken = current.current.loadToken
    if (prompt.html) optimisticHtml.current.set(clientMessageId, prompt.html)
    update(previous => submitOptimistic(wasBusy ? previous : { ...previous, interrupted: false, optimisticSentAt: submittedAt, streamId: null, heartbeatSettledStreamId: null, sawAssistantPayload: false, interimBoundaryPending: false }, { clientId: clientMessageId, text: prompt.text }))
    try {
      const result = await post('prompt', { ...prompt, clientMessageId })
      if (activeKey.current !== key) return
      if (result.status === 'queued') {
        queued.current.add(clientMessageId)
        update(previous => {
          const waiting = previous.messages.find(message => message.id === clientMessageId)
          // Only requeue a message that has not started its own turn yet.
          return waiting && (waiting.source === 'queued' || waiting.pending) ? { ...previous, messages: [...previous.messages.filter(message => message.id !== clientMessageId), { ...waiting, source: 'queued' as const }] } : previous
        })
      } else if (result.status === 'redirected') {
        queued.current.delete(clientMessageId)
        update(previous => placeSteer(previous, clientMessageId))
      } else if (result.status === 'steered') {
        // Hermes reads a steer after the current tool batch, or runs it as the next turn.
        queued.current.delete(clientMessageId)
        update(previous => markSteerPending(previous, clientMessageId))
      } else if (wasBusy) {
        // The earlier turn ended first, so this message started its own turn.
        update(previous => {
          const message = previous.messages.find(item => item.id === clientMessageId)
          return message?.source === 'queued' ? { ...previous, messages: [...previous.messages.filter(item => item.id !== clientMessageId), { ...message, source: 'optimistic' as const }] } : previous
        })
      }
      if (result.autoContinue) update(previous => ({ ...previous, status: 'Hermes is continuing an interrupted turn; your message is queued' }))
    } catch {
      // Failed/ambiguous submissions remain visible, but are never submitted automatically again.
      if (activeKey.current !== key) return
      queued.current.delete(clientMessageId)
      update(previous => {
        const ownsTurn = !wasBusy && previous.busy && !previous.live
          && previous.optimisticSentAt === submittedAt && previous.loadToken === loadToken
          && previous.optimistic.at(-1)?.clientId === clientMessageId
        return { ...previous, ...(ownsTurn ? { busy: false, awaitingResponse: false } : {}),
          messages: previous.messages.map(message => message.id === clientMessageId ? { ...message, pending: false, steerPending: false, ...(message.source === 'queued' ? { source: 'optimistic' as const } : {}) } : message) }
      })
    }
  }, [post, readOnly, surface, update, conversationKey, connection])
  const resolveRequest = useCallback(async (request: PendingRequest, action: string, body: unknown) => {
    const key = conversationKey
    await post(action, body)
    if (activeKey.current !== key) return
    update(previous => ({ ...previous, ...reduce(previous, { type: 'client.request.resolve', payload: { id: String(request.id) } }, context) }))
  }, [post, update, conversationKey])
  const html = mapMessageHtml(state.messages, htmlRows)
  for (const message of state.messages) {
    const ids = message.clientIds ?? (message.source === 'optimistic' ? [message.id] : [])
    if (ids.length === 1 && optimisticHtml.current.has(ids[0])) html.set(message.id, optimisticHtml.current.get(ids[0])!)
  }
  const loadEarlier = async () => {
    const key = conversationKey
    const snapshot = lastSnapshot.current
    if (!key || !olderCursor || !snapshot || historyLoading.current) return
    historyLoading.current = true; setLoadingEarlier(true)
    try {
      const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(key)}/history?before=${encodeURIComponent(olderCursor)}&limit=200`)
      if (activeKey.current !== key) return
      if (response.status === 404) return
      if (!response.ok) throw new Error(`History failed (${response.status})`)
      const page = await response.json() as { messages: GatewayChatSnapshot['messages']; olderCursor?: string | null }
      if (activeKey.current !== key) return
      const known = new Set(earlierRows.current.map(row => row.id))
      earlierRows.current = [...page.messages.filter(row => !known.has(row.id)), ...earlierRows.current]
      const messages = stateFromSnapshot({ ...snapshot, messages: page.messages, running: false, inflight: null, queued: null }, context).messages
      update(previous => {
        const ids = new Set(previous.messages.map(message => message.id))
        return { ...previous, messages: [...messages.filter(message => !ids.has(message.id)), ...previous.messages] }
      })
      setOlderCursor(page.olderCursor ?? null)
    } catch (error) {
      if (activeKey.current === key) surface(error instanceof Error ? error.message : String(error))
    } finally { historyLoading.current = false; setLoadingEarlier(false) }
  }
  const addNotice = useCallback((notice: Notice) => update(previous => withNotice(previous, notice, context)), [update])
  // The transcript waits for history ordering, but the dock need not. Preview
  // buffered lifecycle frames with the real reducer without advancing the live
  // watermark or consuming the buffer before the snapshot arrives.
  const visibleSubagents = useMemo(() => {
    // Effects reset the store after rendering; never paint the prior key's dock.
    if (state.key !== (conversationKey ?? null)) return initialSubagents()
    if (!state.hydrating) return state.subagents
    const events = state.buffered.filter(event => event.type.startsWith('subagent.') || event.type === 'message.start')
    const generation = state.generation === 0 ? events.find(event => event.generation !== undefined)?.generation ?? 0 : state.generation
    return applyLive({ ...state, hydrating: false, generation }, events, context).subagents
  }, [state, conversationKey])
  return {
    active: state.busy || visibleSubagents.items.some(child => !isTerminalSubagent(child.status)),
    state, subagents: visibleSubagents, todos: state.todos, tails, connection, send, readOnly, html, olderCursor, loadingEarlier, loadEarlier,
    completeSlash: async (text, signal) => {
      if (!conversationKey || !enabled) { throw new Error('No active gateway conversation') }
      const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(conversationKey)}/slash-complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal,
      })
      const result = await response.json()
      if (!response.ok) { throw new Error(result.error || 'Command completion unavailable') }
      return result as SlashCompletion
    },
    addNotice,
    executeSlash: async (command) => {
      const key = conversationKey
      const result = await post('slash-execute', { command })
      if (activeKey.current === key && /^\/(?:compress|compact|undo|retry)(?:\s|$)/i.test(command)) {
        earlierRows.current = []
        lastSnapshot.current = null
        setOlderCursor(null)
        resync()
      }
      return result
    },
    setModel: async (model, provider, confirm) => {
      const key = conversationKey
      const result = await post('model', { model, provider, confirm })
      if (activeKey.current === key && !result.confirm_required) {
        update(previous => ({
          ...previous, model: typeof result.value === 'string' ? result.value : model, provider: provider ?? previous.provider,
        }))
        resync()
      }
      return result
    },
    setReasoning: async (effort) => {
      const key = conversationKey
      const result = await post('reasoning', { effort })
      if (activeKey.current === key) {
        update(previous => ({
          ...previous, reasoningEffort: typeof result.value === 'string' ? result.value : effort, reasoningEffortWire: null,
        }))
      }
      return result
    },
    setFast: async (enabled) => {
      const key = conversationKey
      const result = await post('fast', { enabled })
      if (activeKey.current === key) { update(previous => ({ ...previous, fast: result.value === 'fast' || result.value === 'ultrafast' })) }
      return result
    },
    retry: async () => {
      const lastUser = current.current.messages.findLast(message => message.role === 'user')
      if (lastUser) await send({ text: messageText(lastUser), html: html.get(lastUser.id) })
      else resync()
    },
    queuedMessageIds: state.messages.filter(message => message.source === 'queued').map(message => message.id),
    queuedMessages: state.messages.filter(message => message.source === 'queued').map(message => ({ id: message.id, text: steerOwnText(messageText(message)), steer: Boolean(message.steerPending) })),
    interrupt: async () => {
      const key = conversationKey
      try {
        await post('interrupt', {})
        if (activeKey.current !== key) return
        const removed = new Set(queued.current)
        queued.current.clear()
        update(previous => ({ ...previous,
          optimistic: previous.optimistic.filter(submission => !removed.has(submission.clientId)),
          messages: previous.messages.filter(message => !removed.has(message.id) && message.source !== 'queued') }))
      } catch { /* surfaced */ }
    },
    steer: async (text: string) => { try { await post('steer', { text }) } catch { /* surfaced */ } },
    goal: state.goal,
    /** Pause, resume, clear or edit the standing goal; the returned snapshot updates the card at once. */
    goalControl: async (action: GoalAction, args?: { text?: string; index?: number }) => {
      const key = conversationKey
      const result = await post('control', { action, ...(args ? { args } : {}) })
      if (activeKey.current === key && 'control' in result) update(previous => ({ ...previous, goal: goalFromControl(result.control) }))
      return result
    },
    approve: (request: PendingRequest, choice: 'once' | 'session' | 'always' | 'deny') => resolveRequest(request, 'approval', { request_id: request.requestId ?? request.payload.request_id ?? request.id, choice }),
    answerClarify: (request: PendingRequest, answers: Record<string, string | null>) => resolveRequest(request, 'clarify', { request_id: request.id, answers }),
    subagentTail: async (id: string) => {
      const key = conversationKey
      const result = await post('subagent', { action: 'tail', subagent_id: id })
      if (activeKey.current === key) setTails(previous => ({ ...previous, [id]: result.available === false
        ? 'Transcript unavailable' : [typeof result.text === 'string' ? result.text : '', result.truncated ? '[Transcript truncated]' : ''].filter(Boolean).join('\n\n') }))
    },
    subagentSteer: async (id: string, text: string) => { await post('subagent', { action: 'steer', subagent_id: id, text }) },
    subagentInterrupt: async (id: string) => { await post('subagent', { action: 'interrupt', subagent_id: id }) },
    branch: async (): Promise<HermesConversation | null> => { try { return (await post('branch', {})).conversation as HermesConversation } catch { return null } },
  }
}
