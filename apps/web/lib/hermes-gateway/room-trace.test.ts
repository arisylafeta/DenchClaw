import { describe, it, expect } from 'vitest';
import { sliceRoomTrace } from './room-trace';
import type { RoomEvent } from '../hermes-native';
import type { HermesMessage } from '../hermes-conversations';
const event = (kind: string, id: string, at: number, payload: RoomEvent['payload'] = {}): RoomEvent => ({ kind, event_id: id, created_at: at, actor: { id: 'a' }, payload });
const events: RoomEvent[] = [event('message.user', 'discussion', 1), ...[1, 2].flatMap(n => [event('message.member', `reply${n}`, n * 10, { member_id: 'a', turn_id: `t${n}`, text: `Answer ${n}` }), event('turn.settled', `settle${n}`, n * 10 + 1, { member_id: 'a', turn_id: `t${n}`, message_event_id: `reply${n}`, discussion_event_id: 'discussion', passed: false })])];
const rows: HermesMessage[] = [1, 2].flatMap(n => [{ id: `u${n}`, role: 'user', text: 'prompt', timestamp: n * 10000 - 8000 }, { id: `a${n}`, role: 'assistant', text: `Answer ${n}`, timestamp: n * 10000 - 1000, parts: [{ type: 'reasoning', text: `Reason ${n}` }, { type: 'tool-invocation', toolCallId: `tool${n}`, toolName: 'read_file', args: { path: 'synthetic.txt' }, result: 'ok' }, { type: 'text', text: `Answer ${n}` }] }]);
describe('strict group trace correlation', () => {
  it('slices disjoint turns in one member history', () => {
    const one = sliceRoomTrace(events, rows, 'a', 't1')!;
    const two = sliceRoomTrace(events, rows, 'a', 't2')!;
    expect(one.steps).toBe(1); expect(two.steps).toBe(1);
    expect(JSON.stringify(one.work)).toContain('Reason 1'); expect(JSON.stringify(one.work)).not.toContain('Reason 2');
    expect(JSON.stringify(two.work)).toContain('Reason 2'); expect(JSON.stringify(two.work)).not.toContain('Reason 1');
  });
  it('omits passed turns and ambiguous history', () => {
    expect(sliceRoomTrace(events.map(e => e.event_id === 'settle1' ? { ...e, payload: { ...e.payload, passed: true } } : e), rows, 'a', 't1')).toBeNull();
    expect(sliceRoomTrace(events, [...rows, { id: 'other', role: 'user', text: 'another', timestamp: 3000 }], 'a', 't1')).toBeNull();
    expect(sliceRoomTrace(events, rows.map(r => ({ ...r, timestamp: undefined })), 'a', 't1')).toBeNull();
    expect(sliceRoomTrace(events, rows.map(r => r.id === 'a1' ? { ...r, text: 'unrelated' } : r), 'a', 't1')).toBeNull();
  });
  it('accepts tools without reasoning', () => {
    const noReason = rows.map(r => ({ ...r, parts: r.parts?.filter(p => p.type !== 'reasoning') }));
    expect(sliceRoomTrace(events, noReason, 'a', 't1')?.steps).toBe(1);
  });
});
