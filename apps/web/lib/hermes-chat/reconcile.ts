import { asRecord, type GatewayEvent } from './events'
import { initialState, messageText, reduce, type ChatState, type ReducerContext } from './reducer'
import { normalizeMessageText, stateFromSnapshot, type GatewayChatSnapshot, type SnapshotChatState, type SourcedMessage } from './snapshot'
import { steerOwnText } from './notice'
import { reduceSubagents } from './subagents'

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
  const base = key === state.key ? state : initialReconcileState(sessionId, key)
  if (base.hydrating && base.loadToken > 0) return base
  return { ...base, loadToken: state.loadToken + 1, hydrating: true, buffered: base.buffered, resyncRequired: false }
}
export function needsResync(state: ChatState, event: ResyncEvent): boolean {
  return event.truncated === true || asRecord(event.payload).truncated === true || event.type === 'resync'
    || (event.generation !== undefined && event.generation !== state.generation)
}
/** Events are overlay-only. A changed generation must be hydrated, not reduced. */
export function applyLive(state: ReconcileState, events: readonly GatewayEvent[], ctx: ReducerContext): ReconcileState {
  if (state.hydrating) {
    let next = { ...state, buffered: [...state.buffered, ...events] }
    // Control frames establish acceptance even while their content waits for history.
    // Otherwise a late POST failure can incorrectly settle a newly accepted turn.
    for (const event of events) {
      if (event.session_id && next.sessionId && event.session_id !== next.sessionId) continue
      if (event.type === 'message.start') next = { ...next, busy: true, live: true, awaitingResponse: true, interrupted: false }
      else if (event.type === 'message.complete') next = { ...next, busy: false, live: false, awaitingResponse: false }
    }
    return next
  }
  let next = state
  const ordered: GatewayEvent[] = []
  let sequenced: GatewayEvent[] = []
  const flush = () => { ordered.push(...sequenced.sort((a, b) => a.seq! - b.seq!)); sequenced = [] }
  for (const event of events) {
    if (event.seq !== undefined) sequenced.push(event)
    else { flush(); ordered.push(event) }
  }
  flush()
  // A history read may include a turn committed after its live watermark.
  // Receipts, not sequence numbers alone, prove that its replay is already durable.
  const durableIds = new Set(next.messages.filter(message => message.source === 'durable').map(message => message.rowId))
  const covered = new Set<number>()
  let turnStart = 0
  for (let index = 0; index < ordered.length; index++) {
    const event = ordered[index]
    if (event.type === 'message.start') turnStart = index
    const receipt = event.type === 'message.complete' ? event.payload?.persisted_turn : null
    if (!state.streamId && receipt?.complete && receipt.final_assistant_row_id && durableIds.has(receipt.final_assistant_row_id)
      && receipt.row_ids.every(id => durableIds.has(id))
      && (!receipt.user_row_id || durableIds.has(receipt.user_row_id))
      && (!event.session_id || event.session_id === next.sessionId)
      && (event.generation === undefined || event.generation === next.generation)) {
      for (let cursor = turnStart; cursor <= index; cursor++) covered.add(cursor)
    }
    if (event.type === 'message.complete') turnStart = index + 1
  }
  for (const [index, event] of ordered.entries()) {
    if (event.session_id && next.sessionId && event.session_id !== next.sessionId) continue
    if (needsResync(next, event)) { next = { ...next, resyncRequired: true }; continue }
    if (next.resyncRequired) continue
    // Snapshot watermark applies even to frames delivered without a replay flag.
    if (event.seq !== undefined && event.seq <= next.watermark) continue
    if (covered.has(index) && /^(message\.|reasoning\.|thinking\.|tool\.)/.test(event.type)) {
      next = { ...next, watermark: Math.max(next.watermark, event.seq ?? -1) }
      continue
    }
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
/**
 * A steer is injected into the running turn, so it belongs where the agent is now, not under the turn.
 * Move it after the live assistant message and open a fresh one for what follows.
 */
export function placeSteer(state: ReconcileState, clientId: string): ReconcileState {
  const index = state.messages.findIndex(message => message.id === clientId)
  const user = state.messages.findLastIndex((message, i) => i < index && message.role === 'user' && message.source !== 'queued')
  const stream = state.streamId ? state.messages.findIndex(message => message.id === state.streamId)
    : state.messages.findLastIndex((message, i) => i > user && i < index && message.role === 'assistant')
  if (index < 0 || !state.busy || !state.messages[index].pending) return state
  const steer = { ...state.messages[index], source: 'optimistic' as const, pending: false }
  const live = state.messages.filter((_, i) => i !== index).map(message =>
    message.id === state.messages[stream]?.id ? { ...message, steerBoundary: true } : message)
  // There may be no stream between model calls, or after another accepted steer.
  // Do not put the next steer before an already accepted instruction.
  const boundary = Math.max(user, live.findIndex(message => message.id === state.messages[stream]?.id),
    live.findLastIndex(message => message.role === 'user' && message.source === 'optimistic' && !message.pending))
  const waiting = live.findIndex(message => message.source === 'queued')
  live.splice(boundary < 0 ? (waiting < 0 ? live.length : waiting) : boundary + 1, 0, steer)
  return { ...state, messages: live, streamId: null, awaitingResponse: true, sawAssistantPayload: false }
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
      if (message.clientIds?.includes(first.clientId)) { match = row; consumed = 1; break }
      const target = normalizeMessageText(steerOwnText(messageText(message)))
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
  base.model = state.model
  base.provider = state.provider
  base.reasoningEffort = state.reasoningEffort
  base.reasoningEffortWire = state.reasoningEffortWire
  base.fast = state.fast
  // Keep durable rows which slid off the front of the server's newest window. A snapshot
  // without olderCursor is the whole transcript: nothing slid off, and an in-place compaction
  // re-IDs its head rows, so an old row id below the window's minimum is a superseded copy.
  const firstRow = Math.min(...base.messages.flatMap(message => message.rowId === undefined ? [] : [message.rowId]))
  const ids = new Set(base.messages.map(message => message.id))
  const overlappingWindow = state.messages.some(message => message.source === 'durable' && ids.has(message.id))
  if (snapshot.olderCursor) {
    base.messages.unshift(...state.messages.filter(message => message.source === 'durable' && message.rowId !== undefined
      && overlappingWindow && Number.isFinite(firstRow) && message.rowId < firstRow && !ids.has(message.id)))
  }
  // The snapshot reuses a fixed inflight ID even after a local steer split it.
  // That ID must not alias the closed pre-steer block.
  if (base.streamId && state.messages.some(message => message.id === base.streamId && message.steerBoundary)) {
    const aggregate = base.messages.find(message => message.id === base.streamId)!
    aggregate.id = ctx.id()
    base.streamId = aggregate.id
  }
  // Resolve ownership across the whole snapshot before retaining event-only detail.
  // A completion receipt may move a tool from the final live message to an earlier row.
  const claimed = new Set<object>()
  const claimedTools = new Set<string>()
  const sameReasoning = (a: typeof base.messages[number]['segments'][number], b: typeof a) =>
    a.type === 'reasoning' && b.type === 'reasoning' &&
    (normalizeMessageText(a.text) === normalizeMessageText(b.text) ||
      (Boolean(a.text && b.text) && (a.text.startsWith(b.text) || b.text.startsWith(a.text))))
  for (const old of state.messages) {
    const identity = base.messages.find(item => item.source === 'durable' &&
      (item.id === old.id || (old.rowId !== undefined && item.rowId === old.rowId)))
    const oldUser = state.messages.findLast((item, index) => index < state.messages.indexOf(old) && item.role === 'user' && item.source !== 'queued')
    const userIndex = oldUser ? base.messages.findLastIndex(item => item.role === 'user' &&
      (item.id === oldUser.id || (oldUser.source !== 'durable' && normalizeMessageText(steerOwnText(messageText(item))) === normalizeMessageText(steerOwnText(messageText(oldUser)))))) : -1
    const nextUserIndex = base.messages.findIndex((item, index) => index > userIndex && item.role === 'user')
    const sameTurn = !oldUser || userIndex >= 0
    const active = !state.interrupted && sameTurn && snapshot.generation === state.generation && snapshot.running && old.id === state.streamId
      ? base.messages.find(item => item.id === base.streamId) : undefined
    const completed = !old.pending && old.role === 'assistant' && sameTurn
      ? base.messages.findLast((item, index) => item.role === 'assistant' && index > userIndex &&
        (nextUserIndex < 0 || index < nextUserIndex) && normalizeMessageText(messageText(item)) === normalizeMessageText(messageText(old)))
      : undefined
    let target = identity ?? active ?? completed
    if (!target && old.source !== 'durable' && (!old.pending || old.steerBoundary) && old.role === 'assistant' && old.segments.some(segment => segment.type === 'tool' || segment.type === 'reasoning')) {
      target = { ...old, segments: [...old.segments] }
      base.messages.splice(nextUserIndex < 0 ? base.messages.length : nextUserIndex, 0, target)
    }
    const targetIndex = target ? base.messages.indexOf(target) : -1
    const turnStart = base.messages.findLastIndex((item, index) => index < targetIndex && item.role === 'user')
    for (const detail of old.segments.filter(segment => segment.type === 'tool' || segment.type === 'reasoning')) {
      if (detail.type === 'tool') {
        if (claimedTools.has(detail.toolId)) continue
        claimedTools.add(detail.toolId)
      }
      let owner: typeof base.messages[number] | undefined
      let index = -1
      for (const row of base.messages) {
        index = row.segments.findIndex(segment => !claimed.has(segment) &&
          (segment.id === detail.id || (segment.type === 'tool' && detail.type === 'tool' && segment.toolId === detail.toolId) ||
            (base.messages.indexOf(row) > turnStart && base.messages.indexOf(row) <= targetIndex &&
              (sameReasoning(segment, detail) || (segment.type === 'tool' && detail.type === 'tool' &&
                segment.name === detail.name && JSON.stringify(segment.args) === JSON.stringify(detail.args) &&
                JSON.stringify(segment.result) === JSON.stringify(detail.result))))))
        if (index >= 0) { owner = row; break }
      }
      if (owner) {
        const durable = owner.segments[index]
        const merged = durable.type === 'tool' && detail.type === 'tool'
          ? { ...durable, ...detail, id: durable.id, toolId: durable.toolId, ...(durable.status !== 'running'
            ? { status: durable.status, result: durable.result, error: durable.error, completedAt: durable.completedAt } : {}) }
          : durable.type === 'reasoning' && detail.type === 'reasoning'
            ? { ...detail, ...durable, text: durable.text.length >= detail.text.length ? durable.text : detail.text } : durable
        owner.segments[index] = merged
        claimed.add(merged)
      } else if (target) {
        const textIndex = target.segments.findIndex(segment => segment.type === 'text')
        target.segments.splice(textIndex < 0 ? target.segments.length : textIndex, 0, detail)
        claimed.add(detail)
      }
    }
    if (identity) {
      identity.interrupted = old.interrupted
      identity.error ??= old.error
      if (old.status === 'interrupted' || old.status === 'error') identity.status = old.status
    }
  }
  base.usage = snapshot.usage === undefined ? state.usage : snapshot.usage
  base.subagents = state.subagents

  base.interrupted = !snapshot.running && state.interrupted
  if (!snapshot.todo_state) base.todos = state.todos
  const merged: ReconcileState = { ...state, ...base, ...reconcileOptimistic(state, base), key: snapshot.key,
    hydrating: false, buffered: [], resyncRequired: false, overlay: [], snapshotVersion }
  // User history alone does not resolve assistant prose ownership. Preserve the
  // split timeline until assistant rows own its boundaries, including prose-only
  // blocks. The snapshot aggregate can also be newer than the local continuation.
  const boundaryIndex = state.messages.findIndex(message => message.steerBoundary &&
    !base.messages.some(item => item.source === 'durable' && item.role === 'assistant' &&
      (item.id === message.id || (messageText(message) !== '' && messageText(item) === messageText(message)))))
  if (snapshot.running && snapshot.generation === state.generation && boundaryIndex >= 0) {
    const tail = state.messages.slice(boundaryIndex).filter(message => message.source !== 'queued').map(message => {
      const durableId = merged.clientToMessage[message.id]
      return durableId ? merged.messages.find(item => item.id === durableId) ?? message : { ...message, segments: [...message.segments] }
    })
    const aggregate = base.messages.find(message => message.id === base.streamId)
    if (aggregate) {
      let remainder = messageText(aggregate)
      // Remove prose already represented by closed blocks in timeline order.
      for (const message of tail) {
        if (message.role !== 'assistant' || message.id === state.streamId) continue
        const text = messageText(message)
        if (text && remainder.startsWith(text)) remainder = remainder.slice(text.length)
      }
      const continuation = tail.find(message => message.id === state.streamId)
      if (continuation && remainder.startsWith(messageText(continuation))) {
        const extra = remainder.slice(messageText(continuation).length)
        if (extra) continuation.segments = [...continuation.segments, { id: ctx.id(), type: 'text', text: extra, startedAt: ctx.now() }]
      } else if (!continuation && remainder) {
        tail.push({ ...aggregate, segments: aggregate.segments.map(segment => segment.type === 'text' ? { ...segment, text: remainder } : segment) })
      }
    }
    const tailIds = new Set(tail.map(message => message.id))
    const first = merged.messages.findIndex(message => tailIds.has(message.id) || message.id === base.streamId)
    if (first >= 0) {
      const waiting = merged.messages.filter(message => message.source === 'queued')
      merged.messages = [...merged.messages.slice(0, first), ...tail, ...waiting]
      merged.streamId = state.streamId ?? (aggregate && tail.some(message => message.id === aggregate.id) ? aggregate.id : null)
      merged.watermark = Math.max(merged.watermark, state.watermark)
    }
  }
  merged.optimistic = state.optimistic.map(item => {
    const id = merged.clientToMessage[item.clientId]
    return id && merged.messages.some(message => message.id === id && message.source === 'durable')
      ? { ...item, resolvedMessageId: id } : item
  })
  const replayed = applyLive(merged, [
    ...state.overlay.filter(event => event.seq !== undefined && event.seq > base.watermark && (event.generation === undefined || event.generation === snapshot.generation)),
    ...state.buffered.map(event => event.type === 'request.cancel' || event.type === 'approval.request' || event.type === 'clarify.request' ? { ...event, seq: undefined } : event),
  ], ctx)
  // The child list is read after the replay boundary. Apply it last so an
  // earlier message.start cannot retire a child that finished during the read.
  // Lifecycle reduction still preserves terminal states and retired IDs.
  for (const child of snapshot.subagents ?? []) replayed.subagents = reduceSubagents(replayed.subagents, 'subagent.start', child, ctx.now())
  return replayed
}
