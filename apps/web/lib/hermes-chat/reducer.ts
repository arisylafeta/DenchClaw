/**
 * Ported from Hermes Desktop / shared gateway contracts.
 * Copyright (c) 2025 Nous Research. MIT License.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Notice } from './notice'
import { asRecord, stringValue, type ErrorSurface, type EventPayload, type GatewayEvent, type PersistedTurn, type Usage } from './events'
import { initialSubagents, pruneFinishedSubagents, reduceSubagents, type SubagentState } from './subagents'
import { applyTodos, expireTodos, initialTodos, isTodoToolName, settleTodos, type TodoState } from './todos'

export interface ReducerContext { /** Milliseconds, like Date.now. */ now(): number; id(): string }
export interface TextSegment { type: 'text' | 'reasoning' | 'interim'; id: string; text: string; startedAt: number; completedAt?: number; sourceRowId?: number }
export interface ToolSegment {
  type: 'tool'; id: string; toolId: string; name: string; context?: string
  args: Record<string, unknown>; result?: unknown; summary?: string | null
  message?: string; preview?: string | null; duration_s?: number | null; inline_diff?: string | null
  error?: string | boolean | null; status: 'running' | 'done' | 'error'
  startedAt: number; completedAt?: number
}
export type Segment = TextSegment | ToolSegment
export interface ChatMessage {
  /** A system event stored as a user row; shown as a notice line, not a bubble. */
  notice?: Notice
  source?: 'durable' | 'live' | 'optimistic' | 'queued'
  /** Work before an accepted mid-turn steer remains patchable, but is no longer live. */
  steerBoundary?: boolean
  id: string; role: 'user' | 'assistant'; segments: Segment[]; startedAt: number
  completedAt?: number; pending: boolean; interim?: boolean; interrupted?: boolean
  error?: string; error_surface?: ErrorSurface | null; status?: 'complete' | 'error' | 'interrupted'
  partial?: boolean; persisted_turn?: PersistedTurn | null; rowId?: number
  response_previewed?: boolean | null; response_transformed?: boolean | null; response_reused?: boolean | null
}
export interface PendingRequest { id: string | number; requestId?: string; kind: 'approval' | 'clarify'; payload: EventPayload }
export interface ChatState {
  sessionId: string | null; storedSessionId: string | null; messages: ChatMessage[]
  model: string | null; provider: string | null; reasoningEffort: string | null; reasoningEffortWire: string | null
  /** Priority service tier (`/fast`) for this session; null until Hermes reports it. */
  fast: boolean | null
  busy: boolean; live: boolean; awaitingResponse: boolean; interrupted: boolean; needsInput: boolean
  streamId: string | null; heartbeatSettledStreamId: string | null
  sawAssistantPayload: boolean; adoptedRunningTurn: boolean; interimBoundaryPending: boolean
  turnStartedAt: number | null; optimisticSentAt: number | null
  usage: Usage | null; pendingRequests: PendingRequest[]; status: string | null
  subagents: SubagentState; todos: TodoState
  generation: string | number; watermark: number; duplicates: Record<string, number>
}
export function initialState(sessionId: string | null = null): ChatState {
  return {
    sessionId, storedSessionId: null, messages: [], busy: false, live: false, awaitingResponse: false,
    model: null, provider: null, reasoningEffort: null, reasoningEffortWire: null, fast: null,
    interrupted: false, needsInput: false, streamId: null, heartbeatSettledStreamId: null,
    sawAssistantPayload: false, adoptedRunningTurn: false, interimBoundaryPending: false,
    turnStartedAt: null, optimisticSentAt: null, usage: null, pendingRequests: [], status: null,
    subagents: initialSubagents(), todos: initialTodos(), generation: 0, watermark: -1, duplicates: {}
  }
}
export const messageText = (message: ChatMessage): string => message.segments.filter((s): s is TextSegment => s.type === 'text' || s.type === 'interim').map(s => s.text).join('')
export const selectCurrentMessage = (state: ChatState): ChatMessage | undefined => state.messages.find(m => m.id === state.streamId)
export const selectTools = (state: ChatState): ToolSegment[] => state.messages.flatMap(m => m.segments.filter((s): s is ToolSegment => s.type === 'tool'))
export const selectAwaitingInput = (state: ChatState): boolean => state.pendingRequests.length > 0
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim()
/** Hermes ToolCompletePayload puts execution failures inside result. */
export function toolError(payload: { result?: unknown; error?: unknown; is_error?: unknown }): string | boolean | undefined {
  const result = asRecord(payload.result)
  const error = payload.error || result.error
  if (typeof error === 'string' || error === true) return error
  return payload.is_error === true || result.is_error === true || result.success === false || result.ok === false
    || (typeof result.exit_code === 'number' && result.exit_code !== 0) ? true : undefined
}
const lastUser = (s: ChatState): number => s.messages.findLastIndex(m => m.role === 'user' && m.source !== 'queued')
const sealSegments = (segments: Segment[], now: number, tools = false): Segment[] => segments.map(segment => {
  if (segment.completedAt !== undefined || (segment.type === 'tool' && !tools)) return segment
  return segment.type === 'tool' ? { ...segment, completedAt: now, status: segment.error ? 'error' : 'done' } : { ...segment, completedAt: now }
})
function ensureMessage(s: ChatState, ctx: ReducerContext, now: number): ChatMessage {
  let message = selectCurrentMessage(s)
  if (!message) {
    message = { id: ctx.id(), role: 'assistant', segments: [], pending: true, startedAt: now }
    const waiting = s.messages.findIndex(item => item.source === 'queued')
    s.messages = [...s.messages]
    s.messages.splice(waiting < 0 ? s.messages.length : waiting, 0, message)
    s.streamId = message.id
  }
  return message
}
function updateMessage(s: ChatState, message: ChatMessage): void {
  s.messages = s.messages.map(m => m.id === message.id ? message : m)
}
function appendText(s: ChatState, type: 'text' | 'reasoning', text: string, ctx: ReducerContext, now: number): void {
  if (!text) return
  const message = ensureMessage(s, ctx, now)
  const tail = message.segments.at(-1)
  const segments = tail?.type === type && tail.completedAt === undefined
    ? [...message.segments.slice(0, -1), { ...tail, text: tail.text + text }]
    : [...sealSegments(message.segments, now), { type, id: ctx.id(), text, startedAt: now } as TextSegment]
  updateMessage(s, { ...message, segments })
  s.sawAssistantPayload = true; s.awaitingResponse = false; s.busy = true; s.live = true
}
/** Replace only response prose after the last tool; preserve earlier narration. */
function replaceResponse(message: ChatMessage, text: string, ctx: ReducerContext, now: number, whole = false): ChatMessage {
  if (!text) return message
  if (whole) {
    const boundary = message.segments.findLastIndex(segment => segment.type === 'tool')
    const prefix = message.segments.slice(0, boundary + 1).filter((segment): segment is TextSegment => segment.type === 'text' || segment.type === 'interim').map(segment => segment.text).join('')
    // Partial terminal frames carry the entire retained buffer. Strip the
    // already-visible pre-tool prefix instead of folding narration over tools.
    if (boundary >= 0 && prefix && text.startsWith(prefix)) {
      return replaceResponse(message, text.slice(prefix.length), ctx, now)
    }
  }
  const start = whole ? 0 : message.segments.findLastIndex(s => s.type === 'tool') + 1
  const candidates = message.segments.map((s, i) => ({ s, i })).filter(({ s, i }) => i >= start && (s.type === 'text' || s.type === 'interim'))
  const existing = candidates.map(({ s }) => (s as TextSegment).text).join('')
  if (normalize(existing) === normalize(text)) return message
  const first = candidates[0]?.i
  const segments = message.segments.filter((s, i) => !(i >= start && (s.type === 'text' || s.type === 'interim')))
  const replacement: TextSegment = { type: 'text', id: candidates[0]?.s.id ?? ctx.id(), text, startedAt: candidates[0]?.s.startedAt ?? now }
  segments.splice(first === undefined ? segments.length : Math.min(first, segments.length), 0, replacement)
  return { ...message, segments }
}
function settle(s: ChatState, now: number): void {
  s.messages = s.messages.map(m => ({ ...m, pending: false, completedAt: m.completedAt ?? now, segments: sealSegments(m.segments, now, true) }))
  s.busy = false; s.live = false; s.awaitingResponse = false; s.needsInput = false
  s.streamId = null; s.turnStartedAt = null; s.optimisticSentAt = null; s.status = null
  s.pendingRequests = []; s.todos = settleTodos(s.todos)
}
function upsertTool(s: ChatState, p: EventPayload, complete: boolean, ctx: ReducerContext, now: number): void {
  const stableId = p.tool_id || p.tool_call_id || p.id || ''
  const name = p.name || 'tool'
  const refs = s.messages.flatMap(m => m.segments.flatMap(segment => segment.type === 'tool' ? [{ m, tool: segment }] : []))
  let owner = stableId ? refs.findLast(({ tool }) => tool.toolId === stableId && !Object.hasOwn(tool, 'result')) : undefined
  const args = { ...asRecord(p.arguments), ...asRecord(p.args) }
  const context = p.context || stringValue(args.context) || ['path', 'file', 'query', 'search_term', 'command', 'code', 'question'].map(key => stringValue(args[key])).find(Boolean) || ''
  if (!owner) {
    const pending = refs.filter(({ m, tool }) => (m.id === s.streamId || m.pending || m.interim) && tool.name === name && !Object.hasOwn(tool, 'result') && (!stableId || tool.toolId.startsWith('local:')))
    owner = pending.find(({ tool }) => context && tool.context === context)
    if (!owner && (complete || !stableId)) owner = context ? pending.find(({ tool }) => tool.context === context) : pending[0]
  }
  // Repeated completion patches its current occurrence, never a preceding turn.
  if (!owner && complete && stableId) owner = refs.findLast(({ m, tool }) => s.messages.indexOf(m) > lastUser(s) && tool.toolId === stableId && (m.id === s.streamId || !s.live))
  const message = owner?.m ?? ensureMessage(s, ctx, now)
  const old = owner?.tool
  const tool: ToolSegment = {
    ...old, type: 'tool', id: old?.id ?? ctx.id(), toolId: stableId || old?.toolId || `local:${ctx.id()}`,
    name: p.name || old?.name || 'tool', context: context || old?.context,
    args: { ...old?.args, ...args }, startedAt: old?.startedAt ?? now,
    status: complete ? (toolError(p) || old?.error ? 'error' : 'done') : 'running',
    ...(complete ? { completedAt: now, result: Object.hasOwn(p, 'result') ? p.result : old?.result ?? p.result_text } : {})
  }
  if (!complete) delete tool.completedAt
  for (const key of ['summary', 'message', 'preview', 'duration_s', 'inline_diff', 'error'] as const) {
    if (p[key] !== undefined) Object.assign(tool, { [key]: p[key] })
  }
  if (complete && toolError(p)) tool.error = toolError(p)
  const segments = sealSegments(message.segments, now)
  updateMessage(s, { ...message, segments: old ? segments.map(segment => segment.id === old.id ? tool : segment) : [...segments, tool] })
  if (!owner || message.id === s.streamId) { s.sawAssistantPayload = true; s.awaitingResponse = false; s.status = null }
  if (isTodoToolName(name)) s.todos = applyTodos(s.todos, p, now, true)
}
/** Pure transition. Local actions use the same envelope with type client.submit / client.interrupt / client.tick. */
export function reduce(state: ChatState, event: GatewayEvent, ctx: ReducerContext): ChatState {
  const now = ctx.now()
  if (event.session_id && state.sessionId && event.session_id !== state.sessionId) return state
  const generation = event.generation ?? state.generation
  const changedGeneration = generation !== state.generation
  const watermark = changedGeneration ? -1 : state.watermark
  if (event.replayed && event.seq !== undefined && event.seq <= watermark) return state
  const key = event.seq === undefined ? null : JSON.stringify([generation, event.session_id ?? state.sessionId, event.seq])
  if (key && state.duplicates[key] !== undefined && now - state.duplicates[key] < 30000) return state
  const duplicates = Object.fromEntries(Object.entries(state.duplicates).filter(([, at]) => now - at < 30000))
  if (key) duplicates[key] = now
  const s: ChatState = { ...state, generation, watermark: Math.max(watermark, event.seq ?? -1), duplicates, todos: expireTodos(state.todos, now) }
  const p = event.payload ?? {}
  const text = stringValue(p.text)
  if (event.type === 'client.error') {
    const message = ensureMessage(s, ctx, now)
    updateMessage(s, { ...message, error: p.message || text })
    return s
  }
  if (event.type === 'client.tick') return s
  if (event.type === 'client.submit') {
    s.messages = [...s.messages, { id: p.id || ctx.id(), role: 'user', segments: [{ id: ctx.id(), type: 'text', text, startedAt: now }], startedAt: now, pending: false }]
    s.busy = true; s.awaitingResponse = true; s.interrupted = false; s.optimisticSentAt = now
    s.streamId = null; s.heartbeatSettledStreamId = null; s.sawAssistantPayload = false; s.interimBoundaryPending = false
    return s
  }
  if (event.type === 'client.interrupt') {
    s.messages = s.messages.map(m => m.pending ? { ...m, interrupted: true, status: 'interrupted' } : m)
    settle(s, now); s.interrupted = true; return s
  }
  if (event.type.startsWith('subagent.')) {
    if (!s.interrupted || event.type === 'subagent.complete') s.subagents = reduceSubagents(s.subagents, event.type, p, now)
    return s
  }
  if (event.type === 'message.complete') {
    let message = s.messages.find(m => m.id === (s.streamId ?? s.heartbeatSettledStreamId))
    const previous = s.messages.findLast((m, i) => i > lastUser(s) && m.role === 'assistant')
    if (s.interrupted) {
      if (p.status === 'interrupted' && previous && text.startsWith(messageText(previous))) updateMessage(s, replaceResponse(previous, text, ctx, now, true))
      settle(s, now); return s
    }
    if (!message && previous) {
      const oldText = messageText(previous)
      // A repeated terminal frame contains only the final response, not the
      // already-visible prose from earlier tool rounds in this message.
      const lastTool = previous.segments.findLastIndex(segment => segment.type === 'tool')
      const oldResponse = previous.segments.slice(lastTool + 1).filter((segment): segment is TextSegment => segment.type === 'text' || segment.type === 'interim').map(segment => segment.text).join('')
      const receipt = p.persisted_turn?.final_assistant_row_id
      if (previous.pending || (previous.interim && (text.startsWith(oldText) || oldText.startsWith(text) || (s.interimBoundaryPending && (p.response_previewed || p.response_transformed)) || (receipt && !previous.rowId))) || (!s.live && (normalize(oldText) === normalize(text) || normalize(oldResponse) === normalize(text)))) message = previous
    }
    if (!message && (text || p.error || p.status === 'error')) message = ensureMessage(s, ctx, now)
    if (message) {
      const reused = p.response_reused && normalize(messageText(message)).includes(normalize(text))
      const error = stringValue(p.error) || (p.status === 'error' ? p.message || (!p.partial ? text : '') || 'Turn failed' : undefined)
      let final = reused ? message : replaceResponse(message, text, ctx, now, message.interim || p.partial === true)
      if (error && !p.partial) final = { ...final, segments: final.segments.filter(seg => seg.type !== 'text' && seg.type !== 'interim') }
      const rowId = p.persisted_turn?.final_assistant_row_id
      final = { ...final, interim: false, status: p.status === 'error' || p.status === 'interrupted' ? p.status : 'complete', interrupted: p.status === 'interrupted', partial: p.partial === true, error, error_surface: p.error_surface, persisted_turn: p.persisted_turn,
        response_previewed: p.response_previewed, response_transformed: p.response_transformed, response_reused: p.response_reused,
        ...(typeof rowId === 'number' && Number.isSafeInteger(rowId) && rowId > 0 ? { rowId, segments: final.segments.map((seg, i) => i === final.segments.findLastIndex(t => t.type === 'text' || t.type === 'interim') ? { ...seg, sourceRowId: rowId } : seg) } : {}) }
      const durable = typeof rowId === 'number' ? s.messages.find(item => item.rowId === rowId && item.id !== final.id) : undefined
      if (durable) {
        const receiptIds = new Set(p.persisted_turn?.row_ids ?? [rowId!])
        const owners = s.messages.filter(item => item.rowId !== undefined && receiptIds.has(item.rowId))
        const details = final.segments.filter(segment => (segment.type === 'tool' || segment.type === 'reasoning') &&
          !owners.some(owner => owner.segments.some(existing =>
            (existing.type === 'tool' && segment.type === 'tool' && existing.toolId === segment.toolId) ||
            (existing.type === 'reasoning' && segment.type === 'reasoning' && normalize(existing.text) === normalize(segment.text)))))
        s.messages = s.messages.filter(item => item.id !== final.id)
        updateMessage(s, { ...durable, ...final, id: durable.id, segments: [...details, ...durable.segments] })
      } else updateMessage(s, final)
    }
    if (p.usage) s.usage = { ...s.usage, ...p.usage }
    settle(s, now); s.interimBoundaryPending = false; s.heartbeatSettledStreamId = null; s.adoptedRunningTurn = false
    s.interrupted = p.status === 'interrupted'
    return s
  }
  if (event.type === 'request.cancel') {
    s.pendingRequests = s.pendingRequests.filter(r => String(r.id) !== String(p.id ?? p.request_id) && r.requestId !== (p.id ?? p.request_id))
    s.needsInput = s.pendingRequests.length > 0; return s
  }
  if (event.type === 'session.usage') { if (p.usage) s.usage = { ...s.usage, ...p.usage }; return s }
  if (event.type === 'session.info' || event.type === 'heartbeat') {
    s.storedSessionId = p.stored_session_id ?? s.storedSessionId
    if (typeof p.model === 'string') { s.model = p.model }
    if (typeof p.provider === 'string') { s.provider = p.provider }
    if (typeof p.reasoning_effort === 'string') { s.reasoningEffort = p.reasoning_effort }
    if (typeof p.reasoning_effort_wire === 'string') { s.reasoningEffortWire = p.reasoning_effort_wire }
    if (typeof p.fast === 'boolean') { s.fast = p.fast }
    if (p.running === true && !s.interrupted) {
      s.busy = true; s.live = true; s.adoptedRunningTurn = !s.sawAssistantPayload
    } else if (p.running === false && !(s.optimisticSentAt !== null && !s.live && now - s.optimisticSentAt < 15000)) {
      s.heartbeatSettledStreamId = s.streamId ?? s.heartbeatSettledStreamId; settle(s, now)
    }
    return s
  }
  if (event.type === 'message.start') {
    if (s.interrupted) s.streamId = null
    s.interrupted = false
    s.busy = true; s.live = true; s.awaitingResponse = true; s.turnStartedAt = s.optimisticSentAt ?? now
    s.sawAssistantPayload = false; s.interimBoundaryPending = false; s.heartbeatSettledStreamId = null
    s.subagents = pruneFinishedSubagents(s.subagents)
    return s
  }
  if (s.interrupted) return s
  switch (event.type) {
    case 'message.delta': appendText(s, 'text', text, ctx, now); return s
    case 'reasoning.delta': appendText(s, 'reasoning', text, ctx, now); return s
    case 'reasoning.available': {
      const message = selectCurrentMessage(s)
      // A late block after the turn settled would open a phantom pending message after the answer.
      if (!message && !s.busy && !s.live) return s
      if (message && messageText(message).trim()) return s
      if (message) updateMessage(s, { ...message, segments: message.segments.filter(seg => seg.type !== 'reasoning') })
      appendText(s, 'reasoning', text, ctx, now); return s
    }
    case 'thinking.delta': s.status = text; return s
    case 'tool.generating': s.status = p.name || null; return s
    case 'tool.start': upsertTool(s, p, false, ctx, now); return s
    case 'tool.complete': upsertTool(s, p, true, ctx, now); return s
    case 'message.interim': {
      if (!text.trim()) return s
      let message = selectCurrentMessage(s)
      if (!message) message = s.messages.findLast((m, i) => i > lastUser(s) && m.role === 'assistant' && normalize(messageText(m)) === normalize(text))
      message ??= ensureMessage(s, ctx, now)
      const final = replaceResponse(message, text.trim(), ctx, now, !message.segments.some(seg => seg.type === 'tool' && message!.segments.indexOf(seg) < message!.segments.length - 1))
      updateMessage(s, { ...final, pending: false, interim: true, completedAt: now, segments: sealSegments(final.segments.map(seg => seg.type === 'text' ? { ...seg, type: 'interim' as const } : seg), now, true) })
      s.streamId = null; s.interimBoundaryPending = true; s.sawAssistantPayload = true; return s
    }
    case 'todo.updated': s.todos = applyTodos(s.todos, p, now); return s
    case 'approval.request': case 'approval': case 'clarify.request': {
      const id = event.requestId ?? p.id ?? p.request_id
      if (id === undefined) return s
      const request: PendingRequest = { id, requestId: p.request_id, kind: event.type.startsWith('clarify') ? 'clarify' : 'approval', payload: p }
      s.pendingRequests = [...s.pendingRequests.filter(r => r.id !== id), request]; s.needsInput = true; return s
    }
    case 'status.update': s.status = text; return s
    case 'error': {
      const message = ensureMessage(s, ctx, now)
      updateMessage(s, { ...message, error: p.message || text, error_surface: p.error_surface, status: 'error' })
      settle(s, now); return s
    }
    default: return s
  }
}
