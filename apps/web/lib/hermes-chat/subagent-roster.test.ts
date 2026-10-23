import { expect, it } from 'vitest'
import { applyLive, applySnapshot, beginHydration, initialReconcileState } from './reconcile'
import { activeSubagentCount } from './subagents'
import type { GatewayChatSnapshot } from './snapshot'

const ctx = { now: () => 1000, id: () => 'id' }
const snapshot = (extra: Partial<GatewayChatSnapshot> = {}): GatewayChatSnapshot => ({ key: 'k', conversation: { id: 's', profile: 'p', title: '', working: false }, messages: [], running: false, pendingRequests: [], generation: 1, seq: 0, ...extra })
const start = (seq: number, id = 'old') => ({ type: 'subagent.start', generation: 1, seq, payload: { subagent_id: id, goal: 'Work' } })
const running = () => applyLive(applySnapshot(initialReconcileState('s', 'k'), snapshot(), 0, ctx), [start(1)], ctx)
const refresh = (state: ReturnType<typeof running>, data: GatewayChatSnapshot) => {
  const loading = beginHydration(state)
  return applySnapshot(loading, data, loading.loadToken, ctx)
}

it('retires stale running workers on a successful empty roster and prevents resurrection', () => {
  let state = refresh(running(), snapshot({ seq: 1, subagents: [] }))
  expect(activeSubagentCount(state.subagents.items)).toBe(0)
  expect(state.subagents.items).toEqual([])
  expect(state.subagents.retiredIds).toContain('old')
  state = applyLive(state, [start(2)], ctx)
  state = refresh(state, snapshot({ seq: 2, subagents: [{ subagent_id: 'old', status: 'running' }] }))
  expect(state.subagents.items).toEqual([])
})

it('preserves unavailable rosters and quiet workers explicitly present in a roster', () => {
  expect(activeSubagentCount(refresh(running(), snapshot({ seq: 1 })).subagents.items)).toBe(1)
  expect(activeSubagentCount(refresh(running(), snapshot({ seq: 1, subagents: [{ subagent_id: 'old', status: 'running' }] })).subagents.items)).toBe(1)
})

it('preserves starts received after the pre-list boundary, live or buffered', () => {
  for (const buffered of [false, true]) {
    let state = running()
    if (buffered) { state = beginHydration(state) }
    state = applyLive(state, [start(3, 'new')], ctx)
    state = refresh(state, snapshot({ seq: 2, subagents: [] }))
    expect(state.subagents.items.map(child => child.id)).toEqual(['new'])
    expect(state.subagents.retiredIds).not.toContain('new')
  }
})

it('keeps completion during hydration terminal whether the roster omits it or still says running', () => {
  for (const subagents of [[], [{ subagent_id: 'old', status: 'running' as const }]]) {
    let state = beginHydration(running())
    state = applyLive(state, [{ type: 'subagent.complete', generation: 1, seq: 2, payload: { subagent_id: 'old', status: 'completed' } }], ctx)
    state = applySnapshot(state, snapshot({ seq: 1, subagents }), state.loadToken, ctx)
    expect(state.subagents.items[0].status).toBe('completed')
  }
})

it('replays buffered lifecycle frames against the accepted generation after rejecting stale hydration', () => {
  let state = refresh(running(), snapshot({ seq: 5, subagents: [{ subagent_id: 'old', status: 'running' }] }))
  state = beginHydration(state)
  state = applyLive(state, [start(6, 'new')], ctx)
  state = applySnapshot(state, snapshot({ generation: 0, seq: 100, subagents: [] }), state.loadToken, ctx)
  expect(state.hydrating).toBe(false)
  expect(state.buffered).toEqual([])
  expect(state.resyncRequired).toBe(false)
  expect(state.generation).toBe(1)
  expect(state.snapshotWatermark).toBe(5)
  expect(state.watermark).toBe(6)
  expect(state.subagents.items.map(child => child.id)).toEqual(['old', 'new'])
  state = refresh(state, snapshot({ seq: 5, subagents: [] }))
  expect(state.subagents.items.map(child => child.id)).toEqual(['new'])
})

it('requests resync for buffered newer-generation frames after rejecting stale hydration', () => {
  let state = beginHydration(running())
  state = applyLive(state, [{ ...start(1, 'new'), generation: 2 }], ctx)
  state = applySnapshot(state, snapshot({ generation: 0, seq: 100, subagents: [] }), state.loadToken, ctx)
  expect(state.hydrating).toBe(false)
  expect(state.generation).toBe(1)
  expect(state.resyncRequired).toBe(true)
  expect(state.subagents.items.map(child => child.id)).toEqual(['old'])
})

it('does not let stale tokens, generations or regressive snapshots retire seeded workers', () => {
  let state = refresh(running(), snapshot({ seq: 5, subagents: [{ subagent_id: 'old', status: 'running' }] }))
  expect(applySnapshot(state, snapshot({ seq: 6, subagents: [] }), state.loadToken - 1, ctx)).toBe(state)
  state = refresh(state, snapshot({ seq: 4, subagents: [] }))
  expect(activeSubagentCount(state.subagents.items)).toBe(1)
  state = refresh(state, snapshot({ generation: 0, seq: 100, subagents: [] }))
  expect(activeSubagentCount(state.subagents.items)).toBe(1)
  expect(state.generation).toBe(1)
  expect(state.snapshotWatermark).toBe(5)
  state = refresh(state, snapshot({ seq: 4, subagents: [] }))
  expect(activeSubagentCount(state.subagents.items)).toBe(1)
  expect(state.subagents.retiredIds).not.toContain('old')
  state = refresh(state, snapshot({ seq: 6, subagents: [] }))
  expect(activeSubagentCount(state.subagents.items)).toBe(0)
  expect(state.subagents.retiredIds).toContain('old')
})
