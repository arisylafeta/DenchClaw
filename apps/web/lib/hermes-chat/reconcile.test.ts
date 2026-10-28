import { describe, expect, it } from 'vitest'
import { applyLive, applySnapshot, beginHydration, initialReconcileState, needsResync, placeSteer, submitOptimistic } from './reconcile'
import { messageText } from './reducer'
import type { GatewayChatSnapshot } from './snapshot'
const ctx = { now: () => 1000, id: (() => { let id = 0; return () => `live-${++id}` })() }
const snapshot = (extra: Partial<GatewayChatSnapshot> = {}): GatewayChatSnapshot => ({ key: 'k', conversation: { id: 's', profile: 'p', title: '', working: false }, messages: [], running: false, pendingRequests: [], generation: 2, seq: 10, ...extra })
const initial = () => initialReconcileState('s', 'k')
const delta = (seq: number, text: string, generation = 2) => ({ type: 'message.delta', seq, generation, payload: { text } })

describe('history/live reconciliation', () => {
  it('consumes identical prompt matches in order without relying on gateway row receipts', () => {
    let state = submitOptimistic(initial(), { clientId: 'a', text: 'same' })
    state = submitOptimistic(state, { clientId: 'b', text: 'same' })
    state = applySnapshot(state, snapshot({ messages: [{ id: '1', role: 'user', text: 'same' }, { id: '2', role: 'user', text: 'same' }] }), 0, ctx)
    expect(state.messages.map(message => message.id)).toEqual(['1', '2'])
    expect(state.clientToMessage).toEqual({ a: '1', b: '2' })
  })
  it('claims the durable row of an image prompt that Hermes extended with staging lines', () => {
    const sent = '[Attached files: assets/1-image.png]\n\nthere is a gap under the header'
    let state = submitOptimistic(initial(), { clientId: 'a', text: sent })
    state = applySnapshot(state, snapshot({ messages: [
      { id: '1', role: 'user', text: `${sent}\n@image:/root/.hermes/profiles/devon/images/upload_1.png\n[screenshot]` },
      { id: '2', role: 'assistant', text: 'fixed' },
    ] }), 0, ctx)
    expect(state.messages.map(message => message.id)).toEqual(['1', '2'])
    expect(state.clientToMessage).toEqual({ a: '1' })
  })
  it('does not claim an identical user row that existed before submission', () => {
    let state = applySnapshot(initial(), snapshot({ messages: [{ id: 'old', role: 'user', text: 'same' }] }), 0, ctx)
    state = submitOptimistic(state, { clientId: 'a', text: 'same' })
    state = applySnapshot(state, snapshot({ seq: 11, messages: [{ id: 'old', role: 'user', text: 'same' }, { id: 'new', role: 'user', text: 'same' }] }), 0, ctx)
    expect(state.clientToMessage).toEqual({ a: 'new' })
  })
  it('maps two queue submissions to the single merged durable row', () => {
    let state = submitOptimistic(initial(), { clientId: 'a', text: 'first' })
    state = submitOptimistic(state, { clientId: 'b', text: 'second' })
    state = applySnapshot(state, snapshot({ messages: [{ id: 'merged', role: 'user', text: 'first\n\nsecond' }] }), 0, ctx)
    expect(state.clientToMessage).toEqual({ a: 'merged', b: 'merged' })
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0].clientIds).toEqual(['a', 'b'])
  })
  it('buffers hydration deltas, sorts by sequence and ignores duplicate/replayed events', () => {
    let state = applyLive(initial(), [delta(12, 'B'), delta(11, 'A'), delta(11, 'A'), delta(10, 'old')], ctx)
    expect(state.messages).toHaveLength(0)
    state = applySnapshot(state, snapshot(), 0, ctx)
    expect(state.messages.map(messageText)).toEqual(['AB'])
    expect(state.watermark).toBe(12)
    expect(Object.keys(state.duplicates)).toHaveLength(2)
    expect(applyLive(state, [delta(12, 'B')], ctx)).toBe(state)
  })
  it('discards stale tokens after switching sessions', () => {
    const state = beginHydration(initial(), 'other', 'other-key')
    expect(state.loadToken).toBe(1)
    expect(applySnapshot(state, snapshot(), 0, ctx)).toBe(state)
    expect(applySnapshot(state, snapshot(), 1, ctx)).toBe(state)
  })
  it('replaces compacted history and never resurrects a resolved optimistic row', () => {
    let state = submitOptimistic(initial(), { clientId: 'a', text: 'go' })
    state = applySnapshot(state, snapshot({ messages: [{ id: '1', role: 'user', text: 'go' }, { id: '2', role: 'assistant', text: 'answer' }] }), 0, ctx)
    state = applySnapshot(state, snapshot({ seq: 12, messages: [{ id: 'summary', role: 'assistant', text: 'compact' }] }), 0, ctx)
    expect(state.messages.map(messageText)).toEqual(['compact'])
    state = applySnapshot(state, snapshot({ seq: 13, messages: [{ id: 'summary', role: 'assistant', text: 'compact again' }] }), 0, ctx)
    expect(state.messages.map(messageText)).toEqual(['compact again'])
  })
  it('is idempotent for repeated snapshots, including after live deltas', () => {
    const data = snapshot()
    let state = applySnapshot(initial(), data, 0, ctx)
    expect(applySnapshot(state, data, 0, ctx)).toBe(state)
    state = applyLive(state, [delta(11, 'live')], ctx)
    expect(applySnapshot(state, data, 0, ctx)).toBe(state)
  })
  it('keeps post-snapshot deltas when refreshed history is behind the live stream', () => {
    let state = applySnapshot(initial(), snapshot(), 0, ctx)
    state = applyLive(state, [delta(12, 'later')], ctx)
    state = beginHydration(state)
    state = applySnapshot(state, snapshot({ seq: 11 }), state.loadToken, ctx)
    expect(state.messages.map(messageText)).toEqual(['later'])
  })
  it('flags generation changes and truncated replay without applying unsafe deltas', () => {
    const state = applySnapshot(initial(), snapshot(), 0, ctx)
    expect(needsResync(state, { truncated: true })).toBe(true)
    expect(needsResync(state, delta(1, 'new', 3))).toBe(true)
    const changed = applyLive(state, [delta(1, 'new', 3)], ctx)
    expect(changed.resyncRequired).toBe(true)
    expect(changed.messages).toEqual([])
  })
  it('preserves segment order across optimistic identity replacement', () => {
    let state = submitOptimistic(initial(), { clientId: 'a', text: 'go' })
    state = applySnapshot(state, snapshot({ messages: [{ id: 'u', role: 'user', text: 'go' }, { id: 'a', role: 'assistant', parts: [
      { type: 'text', text: 'before' }, { type: 'tool-invocation', toolCallId: 't', toolName: 'read_file', result: 'ok' }, { type: 'reasoning', text: 'why' }, { type: 'text', text: 'after' }
    ] }] }), 0, ctx)
    expect(state.messages[1].segments.map(segment => segment.type)).toEqual(['text', 'tool', 'reasoning', 'text'])
  })
})

describe("placeSteer", () => {
  it("moves an accepted steer under the live assistant message and opens a new one after it", () => {
    let state = submitOptimistic({ ...initial(), busy: true, streamId: "a1", messages: [{ id: "a1", role: "assistant", segments: [], pending: true, startedAt: 0 }] } as never, { clientId: "s", text: "change course" });
    state = placeSteer(state, "s");
    expect(state.messages.map(message => message.id)).toEqual(["a1", "s"]);
    expect(state.streamId).toBeNull();
    expect(state.messages[1].pending).toBe(false);
    expect(placeSteer({ ...state, busy: false }, "s")).toEqual({ ...state, busy: false });
  });
  it("matches an accepted steer to its envelope-wrapped durable row instead of duplicating it", () => {
    let state = submitOptimistic(initial(), { clientId: 's', text: 'change course' })
    const wrapped = '[OUT-OF-BAND USER MESSAGE — a direct message from the user]\nchange course\n[/OUT-OF-BAND USER MESSAGE]'
    state = applySnapshot(state, snapshot({ messages: [{ id: '10', role: 'user', text: wrapped }] }), 0, ctx)
    expect(state.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(state.clientToMessage).toEqual({ s: '10' })
  })
  it("keeps the live assistant message pending so id-less tool completions still find their tool", () => {
    const state = placeSteer(submitOptimistic({ ...initial(), busy: true, streamId: 'a1', messages: [{ id: 'a1', role: 'assistant', segments: [], pending: true, startedAt: 0 }] } as never, { clientId: 's', text: 'x' }), 's')
    expect(state.messages[0].pending).toBe(true)
  })
});
