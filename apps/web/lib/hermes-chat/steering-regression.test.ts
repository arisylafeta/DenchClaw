import { expect, it } from 'vitest'
import { applyLive, applySnapshot, initialReconcileState, placeSteer, submitOptimistic } from './reconcile'
import { messageText } from './reducer'
import type { GatewayChatSnapshot } from './snapshot'
import { displayTurns } from '../../app/components/chat-native/work-block'
let id = 0
const ctx = { now: () => 1000, id: () => `live-${++id}` }
const snapshot: GatewayChatSnapshot = { key: 'k', conversation: { id: 's', profile: 'p', title: '', working: true }, messages: [], running: true, inflight: { user: 'start', assistant: '', streaming: true }, pendingRequests: [], generation: 1, seq: 0 }
it('splits consecutive accepted steers and keeps continuation below them across a running resync', () => {
  let state = applySnapshot(initialReconcileState('s', 'k'), snapshot, 0, ctx)
  state = applyLive(state, [{ type: 'reasoning.delta', seq: 1, payload: { text: 'Before' } }], ctx)
  state = placeSteer(submitOptimistic(state, { clientId: 'one', text: 'First steer' }), 'one')
  state = placeSteer(submitOptimistic(state, { clientId: 'two', text: 'Second steer' }), 'two')
  expect(state.messages.find(m => m.id === 'two')?.pending).toBe(false)
  state = applyLive(state, [{ type: 'reasoning.delta', seq: 2, payload: { text: 'After' } }], ctx)
  const expected = ['start', '', 'First steer', 'Second steer', '']
  expect(displayTurns(state.messages).map(messageText)).toEqual(expected)
  state = applySnapshot(state, { ...snapshot, seq: 2 }, 0, ctx)
  expect(displayTurns(state.messages).map(messageText)).toEqual(expected)
  expect(state.messages.at(-1)?.segments.some(s => s.type === 'reasoning' && s.text === 'After')).toBe(true)
  state = applySnapshot(state, { ...snapshot, seq: 3, messages: [
    { id: '1', role: 'user', text: 'start', pending: 'inflight' },
    { id: '2', role: 'user', text: '[OUT-OF-BAND USER MESSAGE]\nFirst steer\n[/OUT-OF-BAND USER MESSAGE]' },
  ] }, 0, ctx)
  expect(state.messages.filter(m => m.clientIds?.includes('one'))).toHaveLength(1)
  expect(state.messages.find(m => m.id === '2')?.source).toBe('durable')
  expect(state.messages.at(-1)?.segments[0]).toMatchObject({ text: 'After' })
  state = applySnapshot(state, { ...snapshot, seq: 4, messages: [
    { id: '1', role: 'user', text: 'start', pending: 'inflight' },
    { id: '2', role: 'user', text: '[OUT-OF-BAND USER MESSAGE]\nFirst steer\n[/OUT-OF-BAND USER MESSAGE]' },
    { id: '3', role: 'user', text: '[OUT-OF-BAND USER MESSAGE]\nSecond steer\n[/OUT-OF-BAND USER MESSAGE]' },
  ] }, 0, ctx)
  expect(state.messages.map(m => m.segments.map(s => s.type === 'tool' ? s.name : s.text).join(''))).toEqual([
    'start', 'Before', '[OUT-OF-BAND USER MESSAGE]\nFirst steer\n[/OUT-OF-BAND USER MESSAGE]',
    '[OUT-OF-BAND USER MESSAGE]\nSecond steer\n[/OUT-OF-BAND USER MESSAGE]', 'After',
  ])
})
it('keeps a genuinely waiting queue below new assistant blocks', () => {
  let state = applySnapshot(initialReconcileState('s', 'k'), { ...snapshot, queued: { user: 'Next task' } }, 0, ctx)
  state = { ...state, streamId: null }
  state = applyLive(state, [{ type: 'reasoning.delta', seq: 1, payload: { text: 'Still working' } }], ctx)
  expect(state.messages.at(-1)?.source).toBe('queued')
  expect(state.messages.at(-2)?.segments[0]).toMatchObject({ text: 'Still working' })
})
it('accepts a steer between assistant calls when there is no current stream', () => {
  let state = applySnapshot(initialReconcileState('s', 'k'), snapshot, 0, ctx)
  state = applyLive(state, [{ type: 'message.interim', seq: 1, payload: { text: 'Checking' } }], ctx)
  state = placeSteer(submitOptimistic(state, { clientId: 'one', text: 'Change' }), 'one')
  expect(state.messages.at(-1)?.pending).toBe(false)
})
