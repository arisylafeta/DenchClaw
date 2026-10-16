import { asRecord, type GatewayEvent } from './events'
import { initialState, messageText, reduce, type ChatState, type ReducerContext } from './reducer'
import { normalizeMessageText, stateFromSnapshot, type GatewayChatSnapshot, type SnapshotChatState, type SourcedMessage } from './snapshot'

export interface OptimisticSubmission { clientId: string; text: string }
export interface PendingSubmission extends OptimisticSubmission { knownUserIds: string[]; resolvedMessageId?: string }
export interface ReconcileState extends SnapshotChatState {
  key: string | null; loadToken: number; hydrating: boolean; buffered: GatewayEvent[]
  optimistic: PendingSubmission[]; clientToMessage: Record<string, string>; resyncRequired: boolean
  overlay: GatewayEvent[]; snapshotVersion: string | null
}
export interface ResyncEvent { generation?: string | number; truncated?: boolean; payload?: unknown; type?: string }
export function initialReconcileState(sessionId: string | null = null, key: string | null = sessionId): ReconcileState {
  return { ...initialState(sessionId), key, loadToken: 0, hydrating: true, buffered: [], optimistic: [], clientToMessage: {}, resyncRequired: false, overlay: [], snapshotVersion: null }
}
/** Capture the returned token with the fetch. Switching sessions never interrupts work. */
export function beginHydration(state: ReconcileState, sessionId: string | null = state.sessionId, key: string | null = state.key): ReconcileState {
  const base = sessionId === state.sessionId && key === state.key ? state : initialReconcileState(sessionId, key)
  return { ...base, loadToken: state.loadToken + 1, hydrating: true, buffered: [], resyncRequired: false }
}
export function needsResync(state: ChatState, event: ResyncEvent): boolean {
  return event.truncated === true || asRecord(event.payload).truncated === true || event.type === 'resync'
    || (event.generation !== undefined && event.generation !== state.generation)
}
/** Events are overlay-only. A changed generation must be hydrated, not reduced. */
export function applyLive(state: ReconcileState, events: readonly GatewayEvent[], ctx: ReducerContext): ReconcileState {
  if (state.hydrating) return { ...state, buffered: [...state.buffered, ...events] }
  let next = state
  for (const event of [...events].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity))) {
    if (event.session_id && next.sessionId && event.session_id !== next.sessionId) continue
    if (needsResync(next, event)) { next = { ...next, resyncRequired: true }; continue }
    if (next.resyncRequired) continue
    // Snapshot watermark applies even to frames delivered without a replay flag.
    if (event.seq !== undefined && event.seq <= next.watermark) continue
    next = { ...reduce(next, event, ctx), overlay: [...next.overlay, event] } as ReconcileState
  }
  return next
}
/** clientId is stable CRM identity; no gateway user_row_id is needed. */
export function submitOptimistic(state: ReconcileState, submission: OptimisticSubmission): ReconcileState {
  if (state.optimistic.some(item => item.clientId === submission.clientId)) return state
  const message: SourcedMessage = { id: submission.clientId, role: 'user', source: 'optimistic', clientIds: [submission.clientId],
    pending: true, startedAt: 0, segments: [{ id: `${submission.clientId}:text`, type: 'text', text: submission.text, startedAt: 0 }] }
  return { ...state, messages: [...state.messages, message], busy: true, awaitingResponse: true,
    optimistic: [...state.optimistic, { ...submission, knownUserIds: state.messages.filter(item => item.role === 'user' && item.source === 'durable').map(item => item.id) }] }
}
/** Consume consecutive submissions in order, including the gateway's aggregate queue MERGE. */
function reconcileOptimistic(state: ReconcileState, base: SnapshotChatState): Pick<ReconcileState, 'messages' | 'clientToMessage'> {
  const messages = base.messages.slice()
  const clientToMessage: Record<string, string> = {}
  let cursor = 0
  for (let i = 0; i < state.optimistic.length;) {
    const first = state.optimistic[i]
    const previousId = first.resolvedMessageId
    if (previousId && !messages.some(message => message.id === previousId)) {
      clientToMessage[first.clientId] = previousId
      i++
      continue
    }
    let match = -1
    let consumed = 0
    for (let row = cursor; row < messages.length && match < 0; row++) {
      const message = messages[row]
      if (message.role !== 'user' || first.knownUserIds.includes(message.id)) continue
      const target = normalizeMessageText(messageText(message))
      let combined = ''
      for (let end = i; end < state.optimistic.length; end++) {
        if (state.optimistic[end].knownUserIds.includes(message.id)) break
        combined += (end === i ? '' : '\n\n') + state.optimistic[end].text
        if (normalizeMessageText(combined) === target) { match = row; consumed = end - i + 1; break }
        if (!target.startsWith(normalizeMessageText(combined))) break
      }
    }
    if (match >= 0) {
      const ids = state.optimistic.slice(i, i + consumed).map(item => item.clientId)
      messages[match] = { ...messages[match], clientIds: ids }
      for (const id of ids) clientToMessage[id] = messages[match].id
      cursor = match + 1
      i += consumed
    } else {
      const old = state.messages.find(message => message.id === first.clientId)
      if (old) messages.push(old)
      else messages.push({ id: first.clientId, role: 'user', source: 'optimistic', clientIds: [first.clientId], pending: true,
        startedAt: 0, segments: [{ id: `${first.clientId}:text`, type: 'text', text: first.text, startedAt: 0 }] })
      i++
    }
  }
  return { messages, clientToMessage }
}
/** Stale fetches are identity no-ops. Repeated snapshots replace the base identically. */
export function applySnapshot(state: ReconcileState, snapshot: GatewayChatSnapshot, loadToken: number, ctx: ReducerContext): ReconcileState {
  if (loadToken !== state.loadToken || (state.key !== null && snapshot.key !== state.key)) return state
  const snapshotVersion = JSON.stringify(snapshot)
  if (!state.hydrating && state.snapshotVersion === snapshotVersion) return state
  const base = stateFromSnapshot(snapshot, ctx)
  const merged: ReconcileState = { ...state, ...base, ...reconcileOptimistic(state, base), key: snapshot.key,
    hydrating: false, buffered: [], resyncRequired: false, overlay: [], snapshotVersion }
  merged.optimistic = state.optimistic.map(item => {
    const id = merged.clientToMessage[item.clientId]
    return id && merged.messages.some(message => message.id === id && message.source === 'durable')
      ? { ...item, resolvedMessageId: id } : item
  })
  return applyLive(merged, [...state.overlay.filter(event => event.generation === undefined || event.generation === snapshot.generation), ...state.buffered], ctx)
}
