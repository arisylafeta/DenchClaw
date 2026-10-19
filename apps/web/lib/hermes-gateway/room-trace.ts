import { BoundedReads } from './room-read-cache';
import { conversationKey, parseConversationKey, type HermesMessage } from '../hermes-conversations';
import { readConversation, type RoomEvent } from '../hermes-native';
import { roomSessions } from './room-activity';
import { stateFromSnapshot, type GatewayChatSnapshot } from '../hermes-chat/snapshot';
import type { Segment } from '../hermes-chat/reducer';
export interface RoomTrace { work: Segment[]; startedAt: number; completedAt: number; steps: number }
/** _hosted_task is transient runtime state, not persisted on message rows. Only accept a
 * time window with exactly one user prompt, followed solely by this member's assistant
 * rows, and an exact final-answer match. Ambiguous/compacted/missing timestamps omit the chip. */
export function sliceRoomTrace(events: RoomEvent[], rows: HermesMessage[], memberId: string, turnId: string): RoomTrace | null {
  const settled = events.find(e => e.kind === 'turn.settled' && e.payload.member_id === memberId && e.payload.turn_id === turnId);
  if (!settled || settled.payload.passed || !settled.created_at) return null;
  const reply = events.find(e => e.kind === 'message.member' && e.event_id === settled.payload.message_event_id && e.payload.member_id === memberId && e.payload.turn_id === turnId);
  const discussion = events.find(e => e.event_id === settled.payload.discussion_event_id);
  if (!reply?.created_at || !reply.payload.text || !discussion?.created_at) return null;
  const end = reply.created_at * 1000;
  const previous = events.filter(e => e.kind === 'turn.settled' && e.payload.member_id === memberId && e.payload.turn_id !== turnId && e.created_at && e.created_at < reply.created_at!).map(e => e.created_at! * 1000);
  const start = Math.max(discussion.created_at * 1000, ...previous);
  // Zero or absent timestamps cannot establish a disjoint turn window.
  if (rows.some(row => !row.timestamp)) return null;
  const window = rows.filter(row => row.timestamp! > start && row.timestamp! <= end);
  if (window.filter(row => row.role === 'user').length !== 1 || window[0]?.role !== 'user' || window.slice(1).some(row => row.role !== 'assistant')) return null;
  if (window.at(-1)?.text.trim() !== reply.payload.text.trim()) return null;
  const snapshot = { key: 'trace', conversation: { id: 'trace', profile: '', title: '', working: false }, messages: window, running: false, pendingRequests: [], generation: 0, seq: 0 } satisfies GatewayChatSnapshot;
  const state = stateFromSnapshot(snapshot, { now: () => end, id: () => "trace" });
  const all = state.messages.filter(m => m.role === 'assistant').flatMap(m => m.segments);
  // Exclude the final published answer but preserve narration between tool rounds.
  const lastWork = all.findLastIndex(s => s.type !== 'text');
  if (lastWork < 0) return null;
  const work = all.slice(0, lastWork + 1);
  if (work.some(s => s.type === 'tool' && s.status === 'running')) return null;
  return { work, startedAt: window[0].timestamp!, completedAt: end, steps: work.filter(s => s.type === 'tool').length };
}
const traces = new BoundedReads<RoomTrace | null>(128, 60_000, 4 * 1024 * 1024);
const histories = new BoundedReads<Awaited<ReturnType<typeof readConversation>>>(64, 5000, 8 * 1024 * 1024);
const probes = new BoundedReads<RoomTrace | null>(128, 5000, 4 * 1024 * 1024);
const roomLimits = new Map<string, { active: number }>();
function sharedHistory(key: string) {
  return histories.read(key, () => readConversation(key, 0, 200));
}
export function readRoomTrace(key: string, memberId: string, turnId: string): Promise<RoomTrace | null> {
  const identity = parseConversationKey(key);
  if (identity.kind !== 'group') throw Error('Group required');
  const cacheKey = JSON.stringify([key, memberId, turnId]);
  return probes.read(cacheKey, async () => {
    // At most two probes per room. Excess mounted replies omit their chip, not queue
    // unbounded history reads. Both room log and member history have a 200-row cap.
    const slot = roomLimits.get(key) ?? { active: 0 };
    if (slot.active >= 2) return null;
    slot.active++; roomLimits.set(key, slot);
    try {
      return await traces.read(cacheKey, async () => {
        const detail = await sharedHistory(key);
        const member = detail.conversation.participants.find(m => m.memberId === memberId);
        if (!member || !('events' in detail)) return null;
        const sessions = await roomSessions(member.profile, identity.id);
        if (sessions.length !== 1) return null;
        const history = await sharedHistory(conversationKey('solo', sessions[0].id, member.profile));
        return sliceRoomTrace(detail.events ?? [], history.messages, memberId, turnId);
      });
    } catch { return null; }
    finally { if (--slot.active === 0) roomLimits.delete(key); }
  });
}
