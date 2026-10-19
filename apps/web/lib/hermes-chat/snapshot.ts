import { noticeForRow } from './notice'
import { asRecord, stringValue, type ErrorSurface, type EventPayload } from './events'
import { initialState, toolError, type ChatMessage, type ChatState, type ReducerContext, type Segment } from './reducer'
import { applyTodos } from './todos'
import type { MessageHtmlRow } from './html-map'
import type { RpcMethods } from '../../vendor/hermes-gateway/gateway-events'
import { reduceSubagents } from './subagents'

export interface SnapshotRow {
  /** Row time in milliseconds when the history source provides it. */
  timestamp?: number
  displayKind?: string; displayMetadata?: unknown
  id: string; role: string; text?: string; content?: string
  parts?: Record<string, unknown>[]; profile?: string; name?: string
  pending?: 'inflight' | 'queued'; clientMessageId?: string
}
export interface SnapshotInflight {
  assistant: string; streaming: boolean; user: string; error?: string; status?: string
  recoverable?: boolean; error_surface?: ErrorSurface | null
}
/** Wire contract shared by the endpoint and the native ChatPanel hook. */
export interface GatewayChatSnapshot {
  usage?: ChatState['usage']
  gateway?: 'connected' | 'unavailable'
  key: string
  subscriptionId?: string
  olderCursor?: string | null
  conversation: { id: string; profile: string; title: string; source?: string; working: boolean }
  messages: SnapshotRow[]; running: boolean; inflight?: SnapshotInflight | null
  queued?: { user: string; count?: number } | null
  pendingRequests: { id: string | number; requestId?: string; method: string; params: Record<string, unknown> }[]
  todo_state?: { todos: unknown; revision: number } | null
  generation: number; seq: number | null; html?: MessageHtmlRow[]
  subagents?: RpcMethods['subagent.list']['result']['subagents']
}
export interface SourcedMessage extends ChatMessage {
  source?: 'durable' | 'live' | 'optimistic' | 'queued'
  clientIds?: string[]
  recoverable?: boolean
}
export interface SnapshotChatState extends ChatState { messages: SourcedMessage[] }
export const normalizeMessageText = (text: string): string => text.replace(/\s+/g, ' ').trim()

function rowMessage(row: SnapshotRow): SourcedMessage | null {
  if (row.role !== 'user' && row.role !== 'assistant') return null
  const at = Number(row.timestamp) > 0 ? Number(row.timestamp) : 0
  const segments: Segment[] = []
  for (const [index, part] of (row.parts ?? []).entries()) {
    const id = `${row.id}:part:${index}`
    if (part.type === 'text' || part.type === 'reasoning') {
      segments.push({ type: part.type, id, text: stringValue(part.text), startedAt: at, completedAt: at })
    } else if (part.type === 'tool-invocation') {
      const tool = { ...asRecord(part.toolInvocation), ...part }
      const error = toolError(tool)
      segments.push({ type: 'tool', id, toolId: stringValue(tool.toolCallId) || id,
        name: stringValue(tool.toolName) || 'tool', args: asRecord(tool.args),
        ...(Object.hasOwn(tool, 'result') ? { result: tool.result } : {}),
        error, status: error ? 'error' : Object.hasOwn(tool, 'result') ? 'done' : 'running',
        startedAt: at, ...(Object.hasOwn(tool, 'result') ? { completedAt: at } : {}) })
    }
  }
  if (!segments.some(segment => segment.type === 'text') && (row.text || row.content)) {
    segments.push({ type: 'text', id: `${row.id}:text`, text: row.text || row.content || '', startedAt: at, completedAt: at })
  }
  const rowId = Number(row.id)
  const notice = noticeForRow({ role: row.role, displayKind: row.displayKind, displayMetadata: row.displayMetadata, text: row.text || row.content })
  return { id: row.id, ...(notice ? { notice } : {}), role: row.role, source: row.pending === 'queued' ? 'queued' : 'durable', segments, startedAt: at, completedAt: at,
    clientIds: row.clientMessageId ? [row.clientMessageId] : undefined,
    pending: Boolean(row.pending), status: 'complete', ...(Number.isSafeInteger(rowId) && rowId > 0 ? { rowId } : {}) }
}
function prompt(id: string, text: string, source: 'live' | 'queued'): SourcedMessage {
  return { id, role: 'user', source, startedAt: 0, pending: source === 'queued',
    segments: [{ id: `${id}:text`, type: 'text', text, startedAt: 0 }] }
}
/** Durable history is always replaced, never appended (including compaction). */
export function stateFromSnapshot(snapshot: GatewayChatSnapshot, ctx: ReducerContext): SnapshotChatState {
  const state: SnapshotChatState = { ...initialState(snapshot.conversation.id), storedSessionId: snapshot.conversation.id,
    generation: snapshot.generation, watermark: snapshot.seq ?? -1,
    messages: snapshot.messages.flatMap(row => { const message = rowMessage(row); return message ? [message] : [] }),
    usage: snapshot.usage ?? null,
    busy: snapshot.running, live: snapshot.running, adoptedRunningTurn: snapshot.running }
  const inflight = snapshot.inflight
  if (inflight) {
    if (inflight.user && !snapshot.messages.some(row => row.pending === 'inflight')) {
      state.messages.push(prompt(`${snapshot.key}:inflight:user`, inflight.user, 'live'))
    }
    const failed = Boolean(inflight.error || inflight.status === 'error')
    if (inflight.assistant || inflight.streaming || failed) {
      const id = `${snapshot.key}:inflight:assistant`
      state.messages.push({ id, role: 'assistant', source: 'live', startedAt: 0,
        segments: inflight.assistant ? [{ id: `${id}:text`, type: 'text', text: inflight.assistant, startedAt: 0,
          ...(!inflight.streaming || failed ? { completedAt: 0 } : {}) }] : [],
        pending: inflight.streaming && !failed, ...(!inflight.streaming || failed ? { completedAt: 0 } : {}),
        ...(failed ? { status: 'error', error: inflight.error || 'Turn failed', partial: Boolean(inflight.assistant),
          recoverable: inflight.recoverable, error_surface: inflight.error_surface } : {}) })
      if (inflight.streaming && !failed) state.streamId = id
      state.sawAssistantPayload = Boolean(inflight.assistant)
    }
  }
  // Queue rows persist immediately, but belong after the current live response.
  const queuedRows = state.messages.filter(message => message.source === 'queued')
  state.messages = [...state.messages.filter(message => message.source !== 'queued'), ...queuedRows]
  if (snapshot.queued?.user && !snapshot.messages.some(row => row.pending === 'queued')) state.messages.push(prompt(`${snapshot.key}:queued:user`, snapshot.queued.user, 'queued'))
  state.pendingRequests = snapshot.pendingRequests.flatMap(request => {
    const kind = request.method === 'approval' || request.method === 'approval.pending' ? 'approval'
      : request.method === 'clarify' ? 'clarify' : null
    return kind ? [{ id: request.id, requestId: request.requestId, kind, payload: request.params as EventPayload } as const] : []
  })
  state.needsInput = state.pendingRequests.length > 0
  state.awaitingResponse = snapshot.running && !state.sawAssistantPayload
  if (snapshot.todo_state) state.todos = applyTodos(state.todos, snapshot.todo_state, ctx.now())
  for (const child of snapshot.subagents ?? []) state.subagents = reduceSubagents(state.subagents, 'subagent.start', child, ctx.now())
  return state
}
