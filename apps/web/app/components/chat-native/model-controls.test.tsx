import { describe, expect, it } from 'vitest'
import { initialReconcileState, applySnapshot, beginHydration } from '@/lib/hermes-chat/reconcile'
import { reduce } from '@/lib/hermes-chat/reducer'
import type { GatewayChatSnapshot } from '@/lib/hermes-chat/snapshot'

const context = { now: () => 10, id: () => 'id' }

describe('native composer model controls', () => {
  it('retains session settings through transcript hydration', () => {
    let state = initialReconcileState(null, 'main:chat')
    state = { ...state, ...reduce(state, { type: 'session.info', payload: { model: 'small', provider: 'openai', reasoning_effort: 'high' } }, context) }
    state = beginHydration(state)
    const snapshot = { key: 'main:chat', conversation: { id: 'chat', profile: 'main', title: 'Chat', working: false }, messages: [], running: false, pendingRequests: [], generation: 0, seq: 1 } satisfies GatewayChatSnapshot
    expect(applySnapshot(state, snapshot, state.loadToken, context)).toMatchObject({ model: 'small', provider: 'openai', reasoningEffort: 'high' })
  })
})
