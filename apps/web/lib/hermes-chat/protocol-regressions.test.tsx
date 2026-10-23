// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
import { ownerAccess } from './access-fixture'
import { messageText, selectTools } from './reducer'
import { ClarifyCard } from '../../app/components/chat-native/requests'
import { buildAgentMessage, stripAgentMessageContext } from '../agent-message'
import { applySnapshot, beginHydration, initialReconcileState } from './reconcile'
class Source {
  static current: Source
  readyState = 1
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  constructor() { Source.current = this }
  close() { this.readyState = 2 }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  emit(type: string, value: unknown) { act(() => this.listeners[type]?.forEach(listener => listener({ data: JSON.stringify(value) } as MessageEvent))) }
}
const snap = (extra: Record<string, unknown> = {}) => ({ key: 'key', conversation: { id: 'stored', profile: 'p', title: 'Chat', working: false, access: ownerAccess }, generation: 1, seq: 0, messages: [], running: false, pendingRequests: [], ...extra })
const gw = (type: string, payload: unknown, seq: number) => Source.current.emit('gw', { key: 'key', session_id: 'stored', generation: 1, type, payload, seq })
const mount = () => renderHook(({ enabled }) => useNativeHermesChat({ conversationKey: 'key', enabled }), { initialProps: { enabled: true } })
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))) })
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals() })
it.each(['completed', 'failed', 'interrupted'])('keeps a finished parent active until its last child is %s', terminal => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ running: true }))
  expect(result.current.active).toBe(true)
  gw('subagent.spawn_requested', { subagent_id: 'child' }, 1)
  gw('message.complete', { text: 'Delegated' }, 2)
  Source.current.emit('snapshot', snap({ seq: 2, subagents: [{ subagent_id: 'child', status: 'queued' }] }))
  expect(result.current.state.busy).toBe(false)
  expect(result.current.active).toBe(true)
  gw('subagent.start', { subagent_id: 'child' }, 3)
  gw('subagent.start', { subagent_id: 'other' }, 4)
  gw('subagent.complete', { subagent_id: 'child', status: terminal }, 5)
  expect(result.current.active).toBe(true)
  gw('subagent.complete', { subagent_id: 'other', status: terminal }, 6)
  expect(result.current.active).toBe(false)
})
it('keeps completion details through a real durable snapshot and refreshes the completed watermark', async () => {
  const { result } = mount()
  Source.current.emit('connection', { connectionId: 'c' })
  Source.current.emit('snapshot', snap())
  gw('message.start', {}, 1)
  gw('tool.complete', { tool_id: 't', name: 'terminal', result: { exit_code: 2 }, duration_s: 3, summary: 'failed command', inline_diff: 'diff' }, 2)
  gw('subagent.progress', { subagent_id: 'child', text: 'Working' }, 3)
  gw('message.complete', { text: 'Done', usage: { input: 42 }, persisted_turn: { row_ids: [5], complete: true, final_assistant_row_id: 5 }, status: 'interrupted' }, 4)
  expect(result.current.state.hydrating).toBe(true)
  Source.current.emit('snapshot', snap({ seq: 4, messages: [{ id: '5', role: 'assistant', text: 'Done' }] }))
  expect(result.current.state.usage).toMatchObject({ input: 42 })
  expect(result.current.subagents.items[0]).toMatchObject({ id: 'child', status: 'running' })
  expect(selectTools(result.current.state)[0]).toMatchObject({ status: 'error', duration_s: 3, summary: 'failed command', inline_diff: 'diff' })
  expect(result.current.state.interrupted).toBe(true)
})
it('buffers requests and cancellation in arrival order during delayed hydration', () => {
  const { result } = mount()
  Source.current.emit('request', { key: 'key', id: 'old', method: 'approval', params: { command: 'pwd' } })
  gw('request.cancel', { id: 'old' }, 1)
  Source.current.emit('request', { key: 'key', id: 'new', method: 'clarify', params: { question: 'Which?' } })
  Source.current.emit('snapshot', snap({ seq: 1 }))
  expect(result.current.state.pendingRequests.map(request => request.id)).toEqual(['new'])
})
it.each([false, true])('reconciles contextual durable text (unstripped=%s) without duplicating the submission', async unstripped => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  const workspaceContext = { filePath: 'notes.txt' }
  await act(() => result.current.send({ text: 'What changed?', html: '<p>What changed?</p>', context: workspaceContext }))
  const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/prompt'))!
  const { clientMessageId, context } = JSON.parse(String(call[1]?.body))
  expect(context).toEqual(workspaceContext)
  const durableText = buildAgentMessage({ userText: 'What changed?', workspaceContext })
  expect(durableText).not.toBe('What changed?')
  const text = unstripped ? durableText : stripAgentMessageContext(durableText)
  Source.current.emit('snapshot', snap({ seq: 1, messages: [{ id: '7', role: 'user', text, ...(unstripped ? { clientMessageId } : {}) }] }))
  expect(result.current.state.messages.map(messageText)).toEqual([text])
  expect(result.current.html.get('7')).toBe('<p>What changed?</p>')
})
it('does not resurrect busy after a queued POST rejects after completion', async () => {
  let reject!: (error: Error) => void
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? new Promise<Response>((_, no) => { reject = no }) : Response.json({}))
  const { result } = mount()
  Source.current.emit('snapshot', snap({ running: true }))
  let sending!: Promise<void>
  act(() => { sending = result.current.send({ text: 'queued' }) })
  gw('message.complete', { text: 'Done' }, 1)
  await act(async () => { reject(new Error('late rejection')); await sending })
  expect(result.current.state.busy).toBe(false)
})
it('settles terminal error-only frames but not command errors', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ running: true }))
  Source.current.emit('error', { error: 'command failed' })
  expect(result.current.state.busy).toBe(true)
  gw('error', { message: 'Session owned elsewhere' }, 1)
  expect(result.current.state).toMatchObject({ busy: false, live: false, awaitingResponse: false })
  expect(result.current.state.messages.at(-1)?.error).toBe('Session owned elsewhere')
})
it('preserves running and awaiting state on hide, and restores authoritative requests on reconnect', () => {
  const { result, rerender } = mount()
  Source.current.emit('snapshot', snap({ running: true, pendingRequests: [{ id: 'r', method: 'clarify', params: { question: 'Which?' } }] }))
  rerender({ enabled: false })
  expect(result.current.state).toMatchObject({ busy: true, needsInput: true })
  rerender({ enabled: true })
  Source.current.emit('gateway', { state: 'lost' })
  expect(result.current.connection).toBe('lost')
  Source.current.emit('gateway', { state: 'connected' })
  Source.current.emit('snapshot', snap())
  expect(result.current.state.pendingRequests).toEqual([])
})
it('hydrates on compaction resync and replaces removed durable history', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ messages: [{ id: '1', role: 'assistant', text: 'old' }] }))
  Source.current.emit('resync', { key: 'key', reason: 'truncated' })
  expect(result.current.state.hydrating).toBe(true)
  Source.current.emit('snapshot', snap({ seq: 10, messages: [{ id: '2', role: 'assistant', text: 'summary' }] }))
  expect(result.current.state.messages.map(messageText)).toEqual(['summary'])
})
it('consumes the real subagent.tail response', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ available: true, text: 'first\nsecond', truncated: true }))
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  await act(() => result.current.subagentTail('child'))
  expect(result.current.tails.child).toBe('first\nsecond\n\n[Transcript truncated]')
})
it('renders an unavailable subagent transcript explicitly', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ available: false, text: '', truncated: false }))
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  await act(() => result.current.subagentTail('child'))
  expect(result.current.tails.child).toBe('Transcript unavailable')
})
it('keeps already locked clarify answers on reconnect', async () => {
  const onClarify = vi.fn()
  render(<ClarifyCard request={{ id: 'r', kind: 'clarify', payload: { questions: [{ qid: 'a', question: 'First', choices: ['One'] }, { qid: 'b', question: 'Second', choices: ['Two'] }], answers: { a: 'One' } } }} onClarify={onClarify} />)
  fireEvent.click(screen.getByRole('radio', { name: /Two/ }))
  expect(onClarify).toHaveBeenCalledWith(expect.anything(), { a: 'One', b: 'Two' })
})
it('does not clear an accepted run when an earlier idle submission rejects late', async () => {
  let reject!: (error: Error) => void
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? new Promise<Response>((_, no) => { reject = no }) : Response.json({}))
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  let sending!: Promise<void>
  act(() => { sending = result.current.send({ text: 'first' }) })
  gw('message.complete', { text: 'first done' }, 1)
  gw('message.start', {}, 2)
  await act(async () => { reject(new Error('late')); await sending })
  expect(result.current.state).toMatchObject({ busy: true, live: true })
})
it.each([{ error: 'bad' }, { success: false }, { ok: false }, { exit_code: 1 }, { is_error: true }])('classifies real tool result failure %j', resultValue => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ running: true }))
  gw('tool.complete', { name: 'terminal', tool_id: 't', result: resultValue }, 1)
  expect(selectTools(result.current.state)[0].status).toBe('error')
})
it('renders repeated durable prompts once each, with inflight and queued rows in order', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ running: true, messages: [
    { id: '1', role: 'user', text: 'repeat' },
    { id: '2', role: 'user', text: 'repeat', pending: 'inflight' },
    { id: '3', role: 'user', text: 'repeat', pending: 'queued' },
    { id: '4', role: 'user', text: 'next', pending: 'queued' },
  ], inflight: { user: 'repeat', assistant: 'working', streaming: true }, queued: { user: 'repeat' } }))
  expect(result.current.state.messages.map(messageText)).toEqual(['repeat', 'repeat', 'working', 'repeat', 'next'])
  expect(result.current.queuedMessageIds).toEqual(['3', '4'])
})
it('marks unavailable gateway snapshots offline and refuses prompt mutation', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ gateway: 'unavailable' }))
  expect(result.current.connection).toBe('lost')
  await act(() => result.current.send({ text: 'do not submit' }))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false)
})

it('adopts new work after an interrupted turn without suppressing its payloads', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  gw('message.start', {}, 1)
  gw('message.delta', { text: 'Old' }, 2)
  gw('message.complete', { text: 'Old', status: 'interrupted', persisted_turn: { row_ids: [5], complete: true, final_assistant_row_id: 5 } }, 3)
  Source.current.emit('snapshot', snap({ seq: 4, running: true, messages: [{ id: '5', role: 'assistant', text: 'Old' }], inflight: { user: 'New question', assistant: '', streaming: true } }))
  expect(result.current.state.interrupted).toBe(false)
  expect(result.current.state.messages.find(message => message.id === '5')?.interrupted).toBe(true)
  gw('message.delta', { text: 'New answer' }, 5)
  gw('tool.start', { tool_id: 'new-tool', name: 'terminal' }, 6)
  Source.current.emit('request', { key: 'key', id: 'srq-new', method: 'approval', params: { request_id: 'approval-new', command: 'pwd' } })
  expect(result.current.state.messages.map(messageText)).toContain('New answer')
  expect(selectTools(result.current.state).map(tool => tool.toolId)).toEqual(['new-tool'])
  expect(result.current.state.pendingRequests.map(request => request.id)).toEqual(['srq-new'])
})

it('keeps live tools and reasoning when a running snapshot replaces synthetic message ids', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  gw('message.start', {}, 1)
  gw('reasoning.delta', { text: 'Need to inspect' }, 2)
  gw('tool.start', { tool_id: 't', name: 'terminal', args: { command: 'pwd' } }, 3)
  gw('message.delta', { text: 'Checking' }, 4)
  Source.current.emit('snapshot', snap({ seq: 4, running: true, inflight: { user: 'Inspect', assistant: 'Checking', streaming: true } }))
  expect(selectTools(result.current.state)).toMatchObject([{ toolId: 't', status: 'running' }])
  expect(result.current.state.messages.flatMap(message => message.segments).filter(segment => segment.type === 'reasoning')).toMatchObject([{ text: 'Need to inspect' }])
})

it('assigns durable detail globally rather than duplicating it onto the final assistant row', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  gw('message.start', {}, 1)
  gw('reasoning.delta', { text: 'First thought' }, 2)
  gw('tool.complete', { tool_id: 't', name: 'terminal', result: 'ok', duration_s: 2, summary: 'Ran command' }, 3)
  gw('reasoning.delta', { text: 'Second thought' }, 4)
  gw('message.complete', { text: 'Done', persisted_turn: { row_ids: [5, 6], complete: true, final_assistant_row_id: 6 } }, 5)
  Source.current.emit('snapshot', snap({ seq: 5, messages: [
    { id: '5', role: 'assistant', parts: [{ type: 'reasoning', text: 'First thought' }, { type: 'tool-invocation', toolInvocation: { toolCallId: 't', toolName: 'terminal', result: 'ok' } }, { type: 'reasoning', text: 'Second thought' }] },
    { id: '6', role: 'assistant', text: 'Done' },
  ] }))
  expect(selectTools(result.current.state)).toMatchObject([{ toolId: 't', duration_s: 2, summary: 'Ran command' }])
  expect(result.current.state.messages[1].segments.map(segment => segment.type)).toEqual(['text'])
  expect(result.current.state.messages.flatMap(message => message.segments).filter(segment => segment.type === 'reasoning').map(segment => segment.type === 'reasoning' && segment.text)).toEqual(['First thought', 'Second thought'])
})

it('coalesces overlapping hydration without dropping the request between notifications', () => {
  const { result } = mount()
  Source.current.emit('resync', { key: 'key' })
  const token = result.current.state.loadToken
  Source.current.emit('request', { key: 'key', id: 'srq-between', method: 'clarify', params: { question: 'Which?' } })
  Source.current.emit('resync', { key: 'key' })
  expect(result.current.state.loadToken).toBe(token)
  Source.current.emit('snapshot', snap({ running: true }))
  expect(result.current.state.pendingRequests.map(request => request.id)).toEqual(['srq-between'])
})

it('refreshes and prunes covered frames on every completion across a long session', () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  for (let turn = 0; turn < 300; turn++) {
    gw('message.start', {}, turn * 3 + 1)
    gw('message.delta', { text: 'token' }, turn * 3 + 2)
    gw('message.complete', { text: 'token' }, turn * 3 + 3)
    expect(result.current.state.hydrating).toBe(true)
    Source.current.emit('snapshot', snap({ seq: turn * 3 + 3 }))
    expect(result.current.state.overlay).toHaveLength(0)
    expect(result.current.state.buffered).toHaveLength(0)
  }
})

it('loads earlier rows idempotently without replacing a live turn and tolerates a missing endpoint', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ olderCursor: '200', running: true, messages: [{ id: '201', role: 'user', text: 'New', pending: 'inflight' }], inflight: { user: 'New', assistant: 'Working', streaming: true } }))
  vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }))
  await act(() => result.current.loadEarlier())
  expect(result.current.state.messages.map(messageText)).toContain('Working')
  expect(result.current.olderCursor).toBe('200')
  vi.mocked(fetch).mockImplementation(async () => Response.json({ messages: [{ id: '1', role: 'user', text: 'Old' }, { id: '201', role: 'user', text: 'New' }], olderCursor: '1' }))
  await act(async () => { await Promise.all([result.current.loadEarlier(), result.current.loadEarlier()]) })
  expect(fetch).toHaveBeenLastCalledWith('/api/hermes/conversations/key/history?before=200&limit=200')
  expect(result.current.state.messages.map(messageText)).toEqual(['Old', 'New', 'Working'])
  await act(() => result.current.loadEarlier())
  expect(result.current.state.messages.filter(message => message.id === '1')).toHaveLength(1)
  expect(result.current.state.busy).toBe(true)
})

it('ignores an old load token rather than applying a stale snapshot to the current hydration', () => {
  const ctx = { now: () => 1, id: () => 'id' }
  let state = beginHydration(initialReconcileState(null, 'key'))
  const oldToken = state.loadToken
  state = applySnapshot(state, snap() as Parameters<typeof applySnapshot>[1], oldToken, ctx)
  state = beginHydration(state)
  expect(applySnapshot(state, snap({ messages: [{ id: 'old', role: 'user', text: 'Stale' }] }) as Parameters<typeof applySnapshot>[1], oldToken, ctx)).toBe(state)
})

it.each([
  ['steer', { status: 'rejected', subagent_id: 'child', text: 'Change direction' }],
  ['interrupt', { found: false }],
] as const)('rejects HTTP 200 negative subagent %s outcomes', async (action, outcome) => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  vi.mocked(fetch).mockResolvedValue(Response.json(outcome))
  await act(async () => {
    const command = action === 'steer' ? result.current.subagentSteer('child', 'Change direction') : result.current.subagentInterrupt('child')
    await expect(command).rejects.toThrow('no longer controllable')
  })
  expect(result.current.state.messages.at(-1)?.error).toContain('no longer controllable')
})

it.each([
  [503, 'gateway_unavailable', 'Gateway disconnected'],
  [409, 'sse_transport', 'SSE transport'],
])('surfaces HTTP %s %s without retrying a prompt', async (status, error, message) => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  vi.mocked(fetch).mockImplementation(async url => String(url).endsWith('/prompt') ? Response.json({ error }, { status }) : Response.json({}))
  await act(() => result.current.send({ text: 'Hello' }))
  expect(result.current.state.messages.some(row => row.error?.includes(message))).toBe(true)
  expect(result.current.state.busy).toBe(false)
  if (status === 503) {
    expect(result.current.connection).toBe('lost')
    await act(() => result.current.send({ text: 'Do not send' }))
  }
  expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/prompt'))).toHaveLength(1)
})

it('retains row 201 after loading all earlier history and sliding the snapshot window', async () => {
  const { result } = mount()
  const rows = Array.from({ length: 401 }, (_, i) => ({ id: String(i + 1), role: 'assistant', text: String(i + 1) }))
  Source.current.emit('snapshot', snap({ olderCursor: '201', messages: rows.slice(200, 400) }))
  vi.mocked(fetch).mockResolvedValue(Response.json({ messages: rows.slice(0, 200), olderCursor: null }))
  await act(() => result.current.loadEarlier())
  Source.current.emit('snapshot', snap({ seq: 1, olderCursor: '201', messages: rows.slice(201) }))
  expect(result.current.olderCursor).toBeNull()
  expect(result.current.state.messages.map(row => row.id)).toEqual(rows.map(row => row.id))
})

it('shows each turn once after Hermes compacts in place mid-turn and re-IDs the head and tail rows', async () => {
  const { result } = mount()
  const row = (id: number, role: string, text: string, parts?: unknown[]) => ({ id: String(id), role, text, ...(parts ? { parts } : {}) })
  Source.current.emit('snapshot', snap({ messages: [row(1, 'user', 'first question'), row(2, 'assistant', 'first answer'), row(3, 'user', 'second question'), row(4, 'assistant', 'second answer')] }))
  await act(() => result.current.send({ text: 'build it' }))
  gw('message.start', {}, 1)
  gw('tool.complete', { tool_id: 't1', name: 'terminal', args: { command: 'ls' }, result: 'ok' }, 2)
  gw('status.update', { kind: 'compacted', text: 'Context compaction complete — continuing turn...' }, 3)
  gw('message.delta', { text: 'Final answer' }, 4)
  gw('message.complete', { text: 'Final answer', status: 'complete', persisted_turn: { row_ids: [13, 14, 15], user_row_id: 13, final_assistant_row_id: 15, complete: false } }, 5)
  // Whole display transcript: head copied to 10/11, middle archived under its own ids, tail copied to 13+.
  Source.current.emit('snapshot', snap({ seq: 5, messages: [row(10, 'user', 'first question'), row(11, 'assistant', 'first answer'), row(3, 'user', 'second question'), row(4, 'assistant', 'second answer'),
    row(13, 'user', 'build it'), row(14, 'assistant', '', [{ type: 'tool-invocation', toolCallId: 't1', toolName: 'terminal', args: { command: 'ls' }, result: 'ok' }]), row(15, 'assistant', 'Final answer')] }))
  expect(result.current.state.messages.map(message => `${message.role}:${messageText(message)}`).filter(line => line !== 'assistant:'))
    .toEqual(['user:first question', 'assistant:first answer', 'user:second question', 'assistant:second answer', 'user:build it', 'assistant:Final answer'])
  expect(result.current.state.busy).toBe(false)
})

it('posts model confirmation and reasoning changes without adopting an unconfirmed model', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  gw('session.info', { model: 'small', provider: 'openai', reasoning_effort: 'medium' }, 1)
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ confirm_required: true, value: 'expensive' }))
  await act(async () => { await result.current.setModel('expensive', 'openai') })
  expect(result.current.state.model).toBe('small')
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: 'expensive', deferred: true }))
  await act(async () => { await result.current.setModel('expensive', 'openai', true) })
  expect(fetch).toHaveBeenLastCalledWith('/api/hermes/conversations/key/model', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ model: 'expensive', provider: 'openai', confirm: true }),
  }))
  expect(result.current.state.model).toBe('expensive')
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ value: 'high' }))
  await act(async () => { await result.current.setReasoning('high') })
  expect(fetch).toHaveBeenLastCalledWith('/api/hermes/conversations/key/reasoning', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ effort: 'high' }),
  }))
  expect(result.current.state.reasoningEffort).toBe('high')
})
