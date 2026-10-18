import { describe, expect, it } from 'vitest'
import { initialState, messageText, reduce, selectTools, type ChatState, type ReducerContext } from './reducer'
import type { EventPayload, GatewayEvent } from './events'

function harness() {
  let time = 1000
  let id = 0
  const ctx: ReducerContext = { now: () => time, id: () => `id-${++id}` }
  let state = initialState('s')
  return {
    get state() { return state },
    set state(value: ChatState) { state = value },
    advance(ms: number) { time += ms },
    send(type: string, payload: EventPayload = {}, envelope: Partial<GatewayEvent> = {}) {
      state = reduce(state, { type, payload, session_id: 's', ...envelope }, ctx)
      return state
    }
  }
}
const start = (h: ReturnType<typeof harness>) => { h.send('client.submit', { text: 'go' }); h.send('message.start') }
const assistant = (h: ReturnType<typeof harness>) => h.state.messages.filter(m => m.role === 'assistant')

describe('ordered Hermes stream', () => {
  it('flushes text/reasoning at tool boundaries and retains chronological narration', () => {
    const h = harness(); start(h)
    h.send('message.delta', { text: 'Before ' }); h.send('message.delta', { text: 'tool' })
    h.send('reasoning.delta', { text: 'why' })
    h.send('tool.start', { tool_id: 't', name: 'edit_file', args: { path: 'x' } })
    h.send('message.delta', { text: 'After' })
    h.send('tool.complete', { tool_id: 't', name: 'edit_file', result: 'ok' })
    const parts = assistant(h)[0].segments
    expect(parts.map(p => p.type)).toEqual(['text', 'reasoning', 'tool', 'text'])
    expect(parts[0]).toMatchObject({ text: 'Before tool', completedAt: 1000 })
    h.send('message.complete', { text: 'After authoritative' })
    expect(messageText(assistant(h)[0])).toBe('Before toolAfter authoritative')
    expect(h.state).toMatchObject({ busy: false, live: false, awaitingResponse: false })
  })

  it('ignores a reasoning block that arrives after the turn settled instead of opening a phantom message', () => {
    const h = harness(); start(h)
    h.send('message.delta', { text: 'Answer' })
    h.send('message.complete', { text: 'Answer' })
    h.send('reasoning.available', { text: 'late summary' })
    expect(assistant(h)).toHaveLength(1)
    expect(assistant(h)[0].segments.map(p => p.type)).toEqual(['text'])
    expect(h.state).toMatchObject({ busy: false, live: false })
  })

  it('uses stable ids, oldest contextual fallback, sparse args, and fresh identities across turns', () => {
    const h = harness(); start(h)
    h.send('tool.start', { tool_id: 'one', name: 'read_file', context: 'a', args: { path: 'a', offset: 1 } })
    h.send('tool.start', { tool_id: 'two', name: 'read_file', context: 'b', args: { path: 'b' } })
    h.advance(50)
    h.send('tool.start', { tool_id: 'one', name: 'read_file', args: { limit: 10 } })
    h.send('tool.complete', { name: 'read_file', context: 'b', result: 'B' })
    h.send('tool.complete', { name: 'read_file', result: 'A' })
    expect(selectTools(h.state).map(t => [t.toolId, t.result])).toEqual([['one', 'A'], ['two', 'B']])
    expect(selectTools(h.state)[0]).toMatchObject({ args: { path: 'a', offset: 1, limit: 10 }, startedAt: 1000, completedAt: 1050 })
    h.send('message.complete', { text: 'done' }); start(h)
    h.send('tool.start', { tool_id: 'one', name: 'read_file', args: { path: 'new' } })
    expect(selectTools(h.state)).toHaveLength(3)
    expect(selectTools(h.state)[0].args.path).toBe('a')
    h.send('tool.complete', { tool_call_id: 'one', name: 'read_file', result: 'new' })
    expect(selectTools(h.state)[2].result).toBe('new')
  })

  it('resolves overlapping same-name id-less calls oldest first', () => {
    const h = harness(); start(h)
    h.send('tool.start', { name: 'read_file', context: 'a' })
    h.send('tool.start', { name: 'read_file', context: 'b' })
    h.send('tool.complete', { name: 'read_file', result: 1 })
    h.send('tool.complete', { name: 'read_file', result: 2 })
    expect(selectTools(h.state).map(t => t.result)).toEqual([1, 2])
  })

  it('keeps interim redelivery in one sealed bubble and patches late tools without stealing the stream', () => {
    const h = harness(); start(h)
    h.send('message.delta', { text: 'Working' })
    h.send('tool.start', { tool_id: 't', name: 'terminal', args: { command: 'pwd' } })
    h.send('message.interim', { text: 'Working', already_streamed: true })
    const sealed = assistant(h)[0].id
    h.send('message.interim', { text: ' Working  ' })
    expect(assistant(h)).toHaveLength(1)
    expect(assistant(h)[0]).toMatchObject({ interim: true, pending: false })
    h.send('message.delta', { text: 'Result' })
    const stream = h.state.streamId
    h.send('tool.complete', { tool_id: 't', name: 'terminal', result: 'here', duration_s: 1, summary: 'pwd', inline_diff: '+x' })
    expect(h.state.streamId).toBe(stream)
    expect(assistant(h)[0].id).toBe(sealed)
    expect(selectTools(h.state)[0]).toMatchObject({ result: 'here', duration_s: 1, summary: 'pwd', inline_diff: '+x' })
    expect(assistant(h)[1].segments).toHaveLength(1)
  })

  it.each(['response_transformed', 'response_previewed'] as const)('settles %s finals onto the owning interim', flag => {
    const h = harness(); start(h)
    h.send('message.interim', { text: 'Draft' })
    h.send('message.complete', { text: 'Rewritten', [flag]: true, persisted_turn: { row_ids: [1, 2], complete: true, final_assistant_row_id: 2 } })
    expect(assistant(h)).toHaveLength(1)
    expect(assistant(h)[0]).toMatchObject({ interim: false, rowId: 2, persisted_turn: { complete: true } })
    expect(messageText(assistant(h)[0])).toBe('Rewritten')
    expect(assistant(h)[0].segments[0]).toMatchObject({ sourceRowId: 2 })
  })

  it('does not overwrite a distinct prior interim after a new message.start', () => {
    const h = harness(); start(h)
    h.send('message.interim', { text: 'Old' })
    h.send('message.start')
    h.send('message.complete', { text: 'New', response_previewed: true })
    expect(assistant(h).map(messageText)).toEqual(['Old', 'New'])
  })

  it('does not duplicate reused finals after tool narration', () => {
    const h = harness(); start(h)
    h.send('message.delta', { text: 'Already delivered' })
    h.send('tool.start', { tool_id: 't', name: 'terminal' })
    h.send('tool.complete', { tool_id: 't', name: 'terminal', result: 'ok' })
    h.send('message.complete', { text: 'Already delivered', response_reused: true })
    expect(messageText(assistant(h)[0])).toBe('Already delivered')
    expect(assistant(h)[0].segments.map(s => s.type)).toEqual(['text', 'tool'])
  })

  it('remembers heartbeat-settled ownership for reordered complete and protects sends for exactly 15 seconds', () => {
    const h = harness(); h.send('client.submit', { text: 'go' })
    h.advance(14999); h.send('session.info', { running: false })
    expect(h.state.busy).toBe(true)
    h.advance(1); h.send('session.info', { running: false })
    expect(h.state.busy).toBe(false)
    h.send('message.start'); h.send('message.delta', { text: 'par' })
    h.send('session.info', { running: false })
    const owner = h.state.heartbeatSettledStreamId
    h.send('message.complete', { text: 'partial final' })
    expect(assistant(h)).toHaveLength(1)
    expect(assistant(h)[0].id).toBe(owner)
    expect(messageText(assistant(h)[0])).toBe('partial final')
  })

  it('retains cancelled prose, accepting only a persisted interrupted extension', () => {
    const h = harness(); start(h); h.send('message.delta', { text: 'Partial' })
    h.send('client.interrupt')
    h.send('message.complete', { text: 'Not cancelled', status: 'complete' })
    expect(messageText(assistant(h)[0])).toBe('Partial')
    h.send('message.complete', { text: 'Partial persisted', status: 'interrupted' })
    expect(messageText(assistant(h)[0])).toBe('Partial persisted')
    expect(h.state.interrupted).toBe(true)
    expect(h.state.live).toBe(false)
  })

  it('replay-gates only replayed events; live seq restart survives after 30 seconds and a new generation resets gating', () => {
    const h = harness(); start(h)
    h.send('message.delta', { text: 'a' }, { seq: 10, generation: 1 })
    h.send('message.delta', { text: 'duplicate' }, { seq: 10, generation: 1 })
    h.send('message.delta', { text: 'old replay' }, { seq: 9, generation: 1, replayed: true })
    h.send('message.delta', { text: 'b' }, { seq: 9, generation: 1 })
    h.advance(30000)
    h.send('message.delta', { text: 'c' }, { seq: 10, generation: 1 })
    h.send('message.delta', { text: 'd' }, { seq: 1, generation: 2, replayed: true })
    expect(messageText(assistant(h)[0])).toBe('abcd')
    expect(h.state.watermark).toBe(1)
    const before = h.state
    h.send('message.delta', { text: 'foreign' }, { session_id: 'other' })
    expect(h.state).toBe(before)
  })

  it('keeps drafting/thinking status out of transcript and replaces available reasoning only before visible prose', () => {
    const h = harness(); start(h)
    h.send('tool.generating', { name: 'terminal' }); h.send('thinking.delta', { text: 'Thinking' })
    expect(assistant(h)).toHaveLength(0)
    h.send('reasoning.delta', { text: 'scratch' }); h.send('reasoning.available', { text: 'Full reason' })
    h.send('message.delta', { text: 'answer' }); h.send('reasoning.available', { text: 'late' })
    expect(assistant(h)[0].segments.map(s => 'text' in s ? s.text : s.name)).toEqual(['Full reason', 'answer'])
  })

  it('tracks JSON-RPC request ids separately from approval ids and removes request.cancel', () => {
    const h = harness(); start(h)
    h.send('approval.request', { request_id: 'approval-1', command: 'rm x' }, { requestId: 'srq-1' })
    h.send('clarify.request', { questions: [{ qid: 'q', question: 'Which?' }] }, { requestId: 'srq-2' })
    expect(h.state.pendingRequests).toHaveLength(2)
    expect(h.state.pendingRequests[0]).toMatchObject({ id: 'srq-1', requestId: 'approval-1' })
    h.send('request.cancel', { id: 'srq-1' })
    expect(h.state.pendingRequests.map(r => r.id)).toEqual(['srq-2'])
    h.send('request.cancel', { id: 'srq-2' })
    expect(h.state.needsInput).toBe(false)
  })

  it('keeps partial text and typed error_surface, usage and tool failure metadata', () => {
    const h = harness(); start(h); h.send('message.delta', { text: 'kept' })
    h.send('tool.start', { tool_id: 't', name: 'terminal' })
    h.send('tool.complete', { tool_id: 't', name: 'terminal', result: { error: 'bad' } })
    const surface = { layer: 'provider', code: 'quota', retryable: true, resets_at: 123 }
    h.send('message.complete', { status: 'error', error: 'limit', partial: true, text: 'kept partial', error_surface: surface, usage: { input: 12, output: 4 } })
    expect(messageText(assistant(h)[0])).toBe('kept partial')
    expect(assistant(h)[0]).toMatchObject({ error: 'limit', error_surface: surface, partial: true, status: 'error' })
    expect(selectTools(h.state)[0]).toMatchObject({ status: 'error', error: 'bad', result: { error: 'bad' } })
    expect(h.state.usage).toMatchObject({ input: 12, output: 4 })
  })

  it('is pure and preserves segment arrival order for every interleaving of two delta and two tool streams', () => {
    function permutations(values: number[]): number[][] {
      if (!values.length) return [[]]
      return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest]))
    }
    for (const order of permutations([0, 1, 2, 3])) {
      const h = harness(); start(h)
      const before = h.state
      const snapshot = JSON.stringify(before)
      for (const index of order) {
        if (index < 2) h.send(index === 0 ? 'message.delta' : 'reasoning.delta', { text: String(index) })
        else h.send('tool.start', { name: 'terminal', tool_id: `t${index}`, args: { command: String(index) } })
      }
      expect(JSON.stringify(before)).toBe(snapshot)
      const actual = assistant(h)[0].segments.map(s => s.type === 'tool' ? s.args.command : s.text)
      expect(actual).toEqual(order.map(String))
    }
  })
})
