import { describe, expect, it } from 'vitest'
import { applyLive, applySnapshot, beginHydration, initialReconcileState } from './reconcile'
import { initialState, messageText, reduce, selectTools } from './reducer'
import type { EventPayload, GatewayEvent } from './events'
import type { GatewayChatSnapshot } from './snapshot'
const ctx = { now: () => 1000, id: (() => { let id = 0; return () => `event-${++id}` })() }
const snapshot = (extra: Partial<GatewayChatSnapshot> = {}): GatewayChatSnapshot => ({ key: 'k', conversation: { id: 's', profile: 'p', title: '', working: false }, messages: [], running: false, pendingRequests: [], generation: 1, seq: 0, ...extra })
const initial = () => initialReconcileState('s', 'k')
// Wire examples from tui_gateway/contracts/events.py, server_requests.py and agent_callbacks.py.
const examples: [string, EventPayload][] = [
  ['message.start', {}], ['message.delta', { text: 'Hello' }], ['reasoning.delta', { text: 'Thinking' }],
  ['reasoning.available', { text: 'Thinking' }], ['thinking.delta', { text: 'Thinking' }],
  ['message.interim', { text: 'Checking', already_streamed: true }], ['message.complete', { text: 'Done', status: 'complete', usage: { input: 20, output: 5 } }],
  ['tool.start', { tool_id: 'call-1', name: 'terminal', args: { command: 'pwd' } }],
  ['tool.complete', { tool_id: 'call-1', name: 'terminal', result: { output: '/tmp', exit_code: 0 }, duration_s: 0.2 }],
  ['tool.generating', { name: 'terminal' }], ['status.update', { text: 'Working' }],
  ['session.info', { stored_session_id: 's', running: true }], ['heartbeat', { running: false }],
  ['session.usage', { usage: { input: 20, output: 5 } }], ['error', { message: 'Failed to initialize agent' }],
  ['todo.updated', { todos: [{ id: '1', content: 'Read file', status: 'in_progress' }], revision: 1 }],
  ['subagent.start', { subagent_id: 'child', goal: 'Read file', task_index: 0, task_count: 1 }],
  ['subagent.progress', { subagent_id: 'child', tool_name: 'read_file', tool_count: 1 }],
  ['subagent.complete', { subagent_id: 'child', status: 'complete', text: 'Done' }],
  ['approval.request', { request_id: 'approval-1', command: 'pwd', choices: ['once', 'deny'] }],
  ['approval', { request_id: 'approval-1', command: 'pwd' }],
  ['clarify.request', { questions: [{ qid: 'q1', question: 'Which file?', choices: ['a', 'b'] }] }],
  ['request.cancel', { request_id: 'approval-1' }],
]
const ignoredContractEvents = 'gateway.ready skin.changed setup.ready notice session.title reaction review.summary tool.output_risk notification.show notification.clear tip.show session.resume_progress session.reclaimed approval.cancelled session.control.update billing.step_up.verification background.complete btw.complete preview.restart.complete preview.restart.progress moa.reference moa.aggregating moa.progress moa.phase preview.open preview.close layout.apply pane.reveal message.reaction agent.terminal.output terminal.close browser.progress browser.controller.command browser.controller.cancel voice.interrupted voice.status voice.transcript wake.detected pet.changed pet.generate.progress pet.hatch.progress cron.changed sessions.changed platforms.changed projects.changed pairing.changed bot_relay.outbox.pending'.split(' ')
const ignoredExamples: Record<string, Record<string, unknown>> = {
  'gateway.ready': { skin: {}, change_events: true, replay_epoch: 'epoch' },
  'skin.changed': { name: 'default', colors: {} },
  'setup.ready': { provider_configured: true, inference_provider: 'nous', free_tier_account: false, free_tier_route: false, has_identity: true, other_providers: false, finished_at: 1000 },
  'notice': { message: 'Capabilities refreshed' }, 'session.title': { session_id: 's', title: 'Chat' },
  'reaction': { kind: 'heart' }, 'review.summary': { text: 'Reviewed' },
  'tool.output_risk': { tool_id: 't', name: 'terminal', risk: 'low', findings: [], redacted: false },
  'notification.show': { text: 'Initializing', level: 'info', kind: 'sticky', key: 'init' },
  'notification.clear': { key: 'init' }, 'tip.show': { selector: '#chat', text: 'Type here' },
  'session.resume_progress': { phase: 'history', status: 'complete', message_count: 2 },
  'session.reclaimed': { session_id: 'runtime', stored_session_id: 's', reason: 'idle_timeout' },
  'approval.cancelled': { session_id: 'runtime', stored_session_id: 's', reason: 'interrupt', cancelled_count: 1, request_ids: ['approval-1'] },
  'session.control.update': { control: { goal: null, loop: null, heartbeat: null, revision: '', updated_at: 0 } },
  'billing.step_up.verification': { verification_url: 'https://example.com/verify', user_code: 'ABCD' },
  'background.complete': { task_id: 'task', text: 'Done' }, 'btw.complete': { task_id: 'task', text: 'Done', question: 'Why?' },
  'preview.restart.complete': { task_id: 'task', text: 'Done' }, 'preview.restart.progress': { task_id: 'task', text: 'Starting' },
  'moa.reference': { label: 'Reference', text: 'Answer' }, 'moa.aggregating': { aggregator: 'model' },
  'moa.progress': { label: 'Reference', refs_done: 1, refs_total: 2 }, 'moa.phase': { phase: 'aggregator' },
  'preview.open': { url: 'http://localhost:3000', label: 'Preview' }, 'preview.close': { url: '' },
  'layout.apply': { preset: 'default' }, 'pane.reveal': { pane: 'terminal' },
  'message.reaction': { row_id: 1, role: 'user', reactions: [] },
  'agent.terminal.output': { process_id: 'process', chunk: 'hello' }, 'terminal.close': { process_id: 'process' },
  'browser.progress': { message: 'Connecting', level: 'info' },
  'browser.controller.command': { command_id: 'command', action: 'navigate', arguments: { url: 'https://example.com' } },
  'browser.controller.cancel': { command_id: 'command' }, 'voice.interrupted': {},
  'voice.status': { state: 'listening' }, 'voice.transcript': { text: 'Hello', typed: false },
  'wake.detected': { phrase: 'Hey Hermes', start_new_session: false }, 'pet.changed': { enabled: false },
  'pet.generate.progress': { token: 'token', count: 1 }, 'pet.hatch.progress': { event: 'progress', detail: 'Drawing' },
  'cron.changed': {}, 'sessions.changed': {}, 'platforms.changed': {}, 'projects.changed': {}, 'pairing.changed': {}, 'bot_relay.outbox.pending': {},
}
for (const type of ['subagent.spawn_requested', 'subagent.thinking', 'subagent.tool']) {
  examples.push([type, { subagent_id: 'child', goal: 'Read file', task_index: 0, task_count: 1, text: 'Reading', tool_name: 'read_file' }])
}
describe('payloadless Hermes contract frames', () => {
  it.each([...examples.map(([type]) => type), ...ignoredContractEvents])('accepts missing payload: %s directly and through hydration', type => {
    const event = { type, seq: 1, generation: 1 }
    expect(() => reduce(initialState('s'), event, ctx)).not.toThrow()
    const state = applySnapshot(applyLive(initial(), [event], ctx), snapshot(), 0, ctx)
    expect(state.watermark).toBe(['approval.request', 'clarify.request', 'request.cancel'].includes(type) ? 0 : 1)
    expect(state.messages.every(message => Array.isArray(message.segments))).toBe(true)
    if (type === 'message.start') expect(state).toMatchObject({ busy: true, live: true, interrupted: false })
    if (type === 'message.complete' || type === 'error') expect(state.busy).toBe(false)
    if (type === 'approval.request' || type === 'clarify.request') expect(state.pendingRequests).toEqual([])
  })
  it.each(ignoredContractEvents)('routes supplemental real wire example: %s', type => {
    const state = applySnapshot(applyLive(initial(), [{ type, seq: 1, payload: ignoredExamples[type] as EventPayload }], ctx), snapshot(), 0, ctx)
    const visible = ['notice', 'session.title', 'review.summary', 'tool.output_risk', 'session.resume_progress', 'session.reclaimed', 'approval.cancelled', 'session.control.update', 'billing.step_up.verification', 'background.complete', 'btw.complete'].includes(type)
    if (visible) { expect(state.messages).toHaveLength(1); expect(state.messages[0].notice?.text).toBeTruthy() }
    else expect(state.messages).toEqual([])
    expect(state.busy).toBe(false)
  })
  it.each(examples)('accepts real wire example: %s', (type, payload) => {
    const event: GatewayEvent = { type, payload, requestId: type.includes('request') ? 'srq-1' : undefined, seq: 1, generation: 1 }
    const state = applySnapshot(applyLive(initial(), [event], ctx), snapshot(), 0, ctx)
    expect(state.messages.every(message => Array.isArray(message.segments))).toBe(true)
    if (type === 'message.delta') expect(state.messages.map(messageText)).toEqual(['Hello'])
    if (type === 'tool.complete') expect(selectTools(state)[0]).toMatchObject({ status: 'done', result: { exit_code: 0 } })
  })
})
it('accepts another client turn after an interrupted idle hydration', () => {
  let state = applySnapshot(initial(), snapshot(), 0, ctx)
  state = { ...state, ...reduce(state, { type: 'client.interrupt' }, ctx) }
  state = beginHydration(state)
  state = applySnapshot(state, snapshot({ seq: 1 }), state.loadToken, ctx)
  state = applyLive(state, [
    { type: 'message.start', seq: 2 }, { type: 'message.delta', seq: 3, payload: { text: 'New turn' } },
    { type: 'tool.start', seq: 4, payload: { tool_id: 'new', name: 'terminal', args: { command: 'pwd' } } },
    { type: 'approval.request', seq: 5, requestId: 'srq-2', payload: { request_id: 'approval-2', command: 'pwd' } },
  ], ctx)
  expect(state).toMatchObject({ interrupted: false, busy: true, needsInput: true })
  expect(state.messages.map(messageText)).toEqual(['New turn'])
  expect(selectTools(state)).toHaveLength(1)
  expect(state.pendingRequests[0].id).toBe('srq-2')
})
it('does not replay a turn already committed after the snapshot watermark', () => {
  const state = applyLive(initial(), [
    { type: 'message.start', seq: 11 }, { type: 'message.delta', seq: 12, payload: { text: 'Done' } },
    { type: 'tool.complete', seq: 13, payload: { tool_id: 't', name: 'terminal', result: 'ok' } },
    { type: 'message.complete', seq: 14, payload: { text: 'Done', persisted_turn: { complete: true, user_row_id: 1, row_ids: [2, 3], final_assistant_row_id: 3 } } },
  ], ctx)
  const next = applySnapshot(state, snapshot({ seq: 10, messages: [
    { id: '1', role: 'user', text: 'Go' },
    { id: '2', role: 'assistant', parts: [{ type: 'tool-invocation', toolCallId: 't', toolName: 'terminal', result: 'ok' }] },
    { id: '3', role: 'assistant', text: 'Done' },
  ] }), 0, ctx)
  expect(next.messages.map(message => message.id)).toEqual(['1', '2', '3'])
  expect(selectTools(next)).toHaveLength(1)
  expect(next.messages.map(messageText)).toEqual(['Go', '', 'Done'])
  expect(next.watermark).toBe(14)
})
it('keeps durable rows displaced by successive newest-200 windows', () => {
  const rows = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => ({ id: String(start + i), role: 'assistant', text: String(start + i) }))
  let state = applySnapshot(initial(), snapshot({ olderCursor: '200', messages: rows(201, 400) }), 0, ctx)
  const older = applySnapshot(initial(), snapshot({ messages: rows(1, 200) }), 0, ctx).messages
  state = { ...state, messages: [...older, ...state.messages] }
  state = applySnapshot(state, snapshot({ seq: 1, olderCursor: '201', messages: rows(202, 401) }), 0, ctx)
  expect(state.messages.map(message => message.id)).toEqual(rows(1, 401).map(row => row.id))
})
it('retains child-mirror completed detail without receipts, then merges equivalent durable detail', () => {
  let state = applySnapshot(initial(), snapshot(), 0, ctx)
  state = applyLive(state, [
    { type: 'message.start', seq: 1 }, { type: 'reasoning.delta', seq: 2, payload: { text: 'Consider files' } },
    { type: 'tool.complete', seq: 3, payload: { tool_id: 'child:tool:1', name: 'read_file', args: { path: 'a' }, result: 'contents' } },
    { type: 'message.complete', seq: 4, payload: { text: 'Done' } },
  ], ctx)
  state = applySnapshot(state, snapshot({ seq: 4 }), 0, ctx)
  expect(selectTools(state)).toHaveLength(1)
  expect(state.messages[0].segments.some(segment => segment.type === 'reasoning')).toBe(true)
  state = applySnapshot(state, snapshot({ seq: 5, messages: [{ id: '2', role: 'assistant', text: 'Done', parts: [
    { type: 'reasoning', text: 'Consider files' },
    { type: 'tool-invocation', toolCallId: 'real-call', toolName: 'read_file', args: { path: 'a' }, result: 'contents' },
  ] }] }), 0, ctx)
  expect(state.messages).toHaveLength(1)
  expect(selectTools(state)).toHaveLength(1)
  expect(state.messages[0].segments.filter(segment => segment.type === 'reasoning')).toHaveLength(1)
})

it('merges overlapping replay delivered one SSE frame at a time by its completion receipt', () => {
  let state = applySnapshot(initial(), snapshot({ seq: 10, messages: [
    { id: '1', role: 'user', text: 'Go' },
    { id: '2', role: 'assistant', parts: [{ type: 'tool-invocation', toolCallId: 't', toolName: 'terminal', result: 'ok' }] },
    { id: '3', role: 'assistant', text: 'Done' },
  ] }), 0, ctx)
  const frames: GatewayEvent[] = [
    { type: 'message.start', seq: 11 },
    { type: 'tool.start', seq: 12, payload: { tool_id: 't', name: 'terminal', args: {} } },
    { type: 'tool.complete', seq: 13, payload: { tool_id: 't', name: 'terminal', result: 'ok' } },
    { type: 'message.delta', seq: 14, payload: { text: 'Done' } },
    { type: 'message.complete', seq: 15, payload: { text: 'Done', persisted_turn: { complete: true, user_row_id: 1, row_ids: [2, 3], final_assistant_row_id: 3 } } },
  ]
  for (const frame of frames) state = applyLive(state, [frame], ctx)
  expect(state.messages.map(message => message.id)).toEqual(['1', '2', '3'])
  expect(selectTools(state)).toHaveLength(1)
  expect(state.messages.map(messageText)).toEqual(['Go', '', 'Done'])
})
