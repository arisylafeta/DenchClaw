import { describe, expect, it } from 'vitest'
import { eventNotice, slashNotice } from './event-notices'
import { initialState, reduce, withNotice } from './reducer'
import { applyLive, applySnapshot, beginHydration, initialReconcileState } from './reconcile'
import type { GatewayChatSnapshot } from './snapshot'
const ctx = { now: () => 1000, id: (() => { let n = 0; return () => `notice-${++n}` })() }
const snapshot: GatewayChatSnapshot = { key: 'k', conversation: { id: 's', profile: 'p', title: '', working: false }, messages: [], running: false, pendingRequests: [], generation: 2, seq: 10 }
describe('event notices', () => {
  it.each(['status.update', 'notice', 'error', 'session.reclaimed', 'session.title', 'session.control.update', 'session.resume_progress', 'background.complete', 'btw.complete', 'tool.output_risk', 'approval.cancelled', 'request.cancel', 'connection.request', 'connection.update', 'billing.step_up.verification', 'review.summary'])('projects %s', type => {
    expect(eventNotice({ type, payload: { text: 'Synthetic update', message: 'Synthetic update' } })?.text).toBeTruthy()
  })
  it.each(['message.delta', 'subagent.complete', 'agent.terminal.output', 'cron.changed', 'reaction', 'tip.show', 'unknown'])('ignores %s', type => expect(eventNotice({ type })).toBeNull())
  it('silently seeds settings and reports actual changes', () => {
    expect(eventNotice({ type: 'session.info', payload: { model: 'a' } })).toBeNull()
    expect(eventNotice({ type: 'session.info', payload: { model: 'a' } }, { model: 'a' })).toBeNull()
    expect(eventNotice({ type: 'session.info', payload: { model: 'b' } }, { model: 'a' })?.text).toBe('model: b')
  })
  it('keeps full multiline output and error/pending/cancelled states', () => {
    const body = 'a'.repeat(200) + '\nsecond line'
    expect(slashNotice('/compress', body).details).toBe(body)
    expect(slashNotice('/compress', body).text.length).toBeLessThanOrEqual(140)
    expect(slashNotice('/compress', 'failed', 'error').tone).toBe('error')
    expect(slashNotice('/compress', '', 'pending').pending).toBe(true)
    expect(slashNotice('/compress', '', 'cancelled').pending).toBe(false)
  })
  it('appends in transcript order and coalesces progress without claiming the stream', () => {
    let state = reduce(initialState('s'), { type: 'message.delta', payload: { text: 'answer' } }, ctx)
    const stream = state.streamId
    state = reduce(state, { type: 'status.update', payload: { text: 'Compacting' } }, ctx)
    state = reduce(state, { type: 'status.update', payload: { text: 'Compacted' } }, ctx)
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].notice?.text).toBe('Compacted')
    expect(state.streamId).toBe(stream)
    state = reduce(state, { type: 'message.complete', payload: { text: 'answer' } }, ctx)
    expect(state.messages[1].segments).toEqual([])
  })
  it('renders idle errors without creating an empty response', () => {
    const state = reduce(initialState(), { type: 'error', payload: { message: 'Could not resume' } }, ctx)
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].notice?.tone).toBe('error')
    expect(state.streamId).toBeNull()
  })
  it('survives resync and yields to equivalent durable rows', () => {
    let state = applySnapshot(initialReconcileState('s', 'k'), snapshot, 0, ctx)
    state = applyLive(state, [{ type: 'background.complete', seq: 11, payload: { text: 'Synthetic result' } }], ctx)
    state = withNotice(state, slashNotice('/compress', 'Compressed'), ctx)
    state = beginHydration(state)
    state = applySnapshot(state, { ...snapshot, seq: 12 }, state.loadToken, ctx)
    expect(state.messages.filter(row => row.notice)).toHaveLength(2)
    state = beginHydration(state)
    state = applySnapshot(state, { ...snapshot, seq: 13, messages: [{ id: '1', role: 'user', text: 'Synthetic result', displayKind: 'async_delegation_complete' }] }, state.loadToken, ctx)
    expect(state.messages.filter(row => row.notice)).toHaveLength(2)
    expect(state.messages.filter(row => row.localNotice)).toHaveLength(1)
  })
})
