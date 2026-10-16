// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
import { messageText, selectTools } from './reducer'
import { ClarifyCard } from '../../app/components/chat-native/requests'
import { chatStatus } from '../../app/components/workspace/hermes-conversations'
class Source {
  static current: Source
  readyState = 1
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  constructor() { Source.current = this }
  close() { this.readyState = 2 }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  emit(type: string, value: unknown) { act(() => this.listeners[type]?.forEach(listener => listener({ data: JSON.stringify(value) } as MessageEvent))) }
}
const snap = (extra: Record<string, unknown> = {}) => ({ key: 'key', conversation: { id: 'stored', profile: 'p', title: 'Chat', working: false }, generation: 1, seq: 0, messages: [], running: false, pendingRequests: [], ...extra })
const gw = (type: string, payload: unknown, seq: number) => Source.current.emit('gw', { key: 'key', session_id: 'stored', generation: 1, type, payload, seq })
const mount = () => renderHook(({ enabled }) => useNativeHermesChat({ conversationKey: 'key', enabled }), { initialProps: { enabled: true } })
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))) })
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals() })
it('keeps completion details through a real durable snapshot and does not hydrate on completion', async () => {
  const { result } = mount()
  Source.current.emit('connection', { connectionId: 'c' })
  Source.current.emit('snapshot', snap())
  gw('message.start', {}, 1)
  gw('tool.complete', { tool_id: 't', name: 'terminal', result: { exit_code: 2 }, duration_s: 3, summary: 'failed command', inline_diff: 'diff' }, 2)
  gw('subagent.progress', { subagent_id: 'child', text: 'Working' }, 3)
  gw('message.complete', { text: 'Done', usage: { input: 42 }, persisted_turn: { row_ids: [5], complete: true, final_assistant_row_id: 5 }, status: 'interrupted' }, 4)
  expect(result.current.state.hydrating).toBe(false)
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
it('round trips display text, stable client identity and HTML after contextual submission', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap())
  await act(() => result.current.send({ text: 'What changed?', html: '<p>What changed?</p>', context: { workspaceName: 'Example' } as never }))
  const call = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/prompt'))!
  const { clientMessageId, context } = JSON.parse(String(call[1]?.body))
  expect(context).toEqual({ workspaceName: 'Example' })
  Source.current.emit('snapshot', snap({ seq: 1, messages: [{ id: '7', role: 'user', text: 'What changed?', clientMessageId }] }))
  expect(result.current.state.messages.map(messageText)).toEqual(['What changed?'])
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
  expect(chatStatus({ blocked: true, working: true } as never, { seen: {}, selected: null })).toBe('awaiting')
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
  await act(() => result.current.subagentTail('child'))
  expect(result.current.tails.child).toBe('first\nsecond\n\n[Transcript truncated]')
})
it('keeps already locked clarify answers on reconnect', async () => {
  const onClarify = vi.fn()
  render(<ClarifyCard request={{ id: 'r', kind: 'clarify', payload: { questions: [{ qid: 'a', question: 'First', choices: ['One'] }, { qid: 'b', question: 'Second', choices: ['Two'] }], answers: { a: 'One' } } }} onClarify={onClarify} />)
  fireEvent.click(screen.getByRole('button', { name: 'Two' }))
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
  ], inflight: { user: 'repeat', assistant: 'working', streaming: true }, queued: { user: 'repeat' } }))
  expect(result.current.state.messages.map(messageText)).toEqual(['repeat', 'repeat', 'working', 'repeat'])
  expect(result.current.queuedMessageIds).toEqual(['3'])
})
it('marks unavailable gateway snapshots offline and refuses prompt mutation', async () => {
  const { result } = mount()
  Source.current.emit('snapshot', snap({ gateway: 'unavailable' }))
  expect(result.current.connection).toBe('lost')
  await act(() => result.current.send({ text: 'do not submit' }))
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith('/prompt'))).toBe(false)
})
