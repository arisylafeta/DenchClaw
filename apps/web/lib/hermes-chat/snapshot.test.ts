import { describe, expect, it } from 'vitest'
import { stateFromSnapshot, type GatewayChatSnapshot } from './snapshot'
import { messageText, reduce, selectTools } from './reducer'
const ctx = { now: () => 1000, id: () => 'live' }
const snapshot = (extra: Partial<GatewayChatSnapshot> = {}): GatewayChatSnapshot => ({ key: 'k', conversation: { id: 's', profile: 'p', title: 'Chat', working: false }, messages: [], running: false, pendingRequests: [], generation: 2, seq: 10, ...extra })

describe('snapshot hydration', () => {
  it('hydrates ordered narration, reasoning, args and string results without flattening', () => {
    const state = stateFromSnapshot(snapshot({ messages: [{ id: '1', role: 'assistant', parts: [
      { type: 'text', text: 'Before' }, { type: 'reasoning', text: 'Why' },
      { type: 'tool-invocation', toolCallId: 't', toolName: 'terminal', args: '{"command":"pwd"}', result: 'out', error: 'failed' },
      { type: 'text', text: 'After' }
    ] }] }), ctx)
    expect(state.messages[0]).toMatchObject({ source: 'durable', pending: false, status: 'complete' })
    expect(state.messages[0].segments.map(part => part.type)).toEqual(['text', 'reasoning', 'tool', 'text'])
    expect(selectTools(state)[0]).toMatchObject({ args: { command: 'pwd' }, result: 'out', error: 'failed', status: 'error' })
  })
  it('patches a snapshot tool still running with a later completion in its original position', () => {
    const state = stateFromSnapshot(snapshot({ running: true, messages: [{ id: '1', role: 'assistant', parts: [
      { type: 'text', text: 'Before' }, { type: 'tool-invocation', toolCallId: 't', toolName: 'terminal', args: { command: 'pwd' } }, { type: 'text', text: 'After' }
    ] }], inflight: { user: '', assistant: '', streaming: true } }), ctx)
    const done = reduce(state, { type: 'tool.complete', seq: 11, generation: 2, payload: { tool_id: 't', name: 'terminal', result: 'out' } }, ctx)
    expect(selectTools(done)).toHaveLength(1)
    expect(selectTools(done)[0]).toMatchObject({ result: 'out', status: 'done' })
    expect(done.messages[0].segments.map(part => part.type)).toEqual(['text', 'tool', 'text'])
  })
  it('deduplicates only the last durable user and restores queue, requests and todo revision', () => {
    const state = stateFromSnapshot(snapshot({ running: true, messages: [{ id: '1', role: 'user', content: 'same  prompt' }],
      inflight: { user: 'same prompt', assistant: 'Answer', streaming: true }, queued: { user: 'next' },
      pendingRequests: [{ id: 'srq-1', requestId: 'approval-1', method: 'approval', params: { command: 'pwd' } }, { id: 'srq-2', method: 'clarify', params: { question: 'Which?' } }],
      todo_state: { todos: [{ id: 'a', content: 'Work', status: 'in_progress' }], revision: 7 } }), ctx)
    expect(state.messages.filter(message => message.role === 'user').map(messageText)).toEqual(['same  prompt', 'next'])
    expect(state.messages.at(-1)).toMatchObject({ source: 'queued', pending: true })
    expect(state).toMatchObject({ busy: true, live: true, generation: 2, watermark: 10, needsInput: true })
    expect(state.pendingRequests.map(request => request.kind)).toEqual(['approval', 'clarify'])
    expect(state.todos).toMatchObject({ revision: 7, visible: [{ id: 'a', content: 'Work', status: 'in_progress' }] })
  })
  it('retains failed partial replies as errors rather than a successful answer', () => {
    const state = stateFromSnapshot(snapshot({ inflight: { user: 'go', assistant: 'partial', streaming: false, error: 'Provider failed', status: 'error', recoverable: true,
      error_surface: { code: 'rate_limit', layer: 'provider', retryable: true } } }), ctx)
    expect(state.messages.at(-1)).toMatchObject({ status: 'error', error: 'Provider failed', partial: true, pending: false, recoverable: true })
    expect(state.streamId).toBeNull()
    expect(state.live).toBe(false)
    expect(messageText(state.messages.at(-1)!)).toBe('partial')
  })
  it('discards replay at the snapshot watermark in the reducer', () => {
    const state = stateFromSnapshot(snapshot(), ctx)
    expect(reduce(state, { type: 'message.delta', generation: 2, seq: 10, replayed: true, payload: { text: 'duplicate' } }, ctx)).toBe(state)
  })
})
