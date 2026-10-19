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
const cache = new Map<string, RoomTrace>();
// Mounted replies probe only summaries. Coalesce their shared room/session history reads,
// keeping full reasoning/tool payloads server-side until the user expands a chip.
const histories = new Map<string, { until: number; pending: ReturnType<typeof readConversation> }>();
function sharedHistory(key: string) {
  const old = histories.get(key); if (old && old.until > Date.now()) return old.pending;
  const pending = readConversation(key);
  if (histories.size >= 64) histories.delete(histories.keys().next().value!);
  histories.set(key, { until: Date.now() + 5000, pending });
  void pending.catch(() => { if (histories.get(key)?.pending === pending) histories.delete(key); });
  return pending;
}
export async function readRoomTrace(key: string, memberId: string, turnId: string): Promise<RoomTrace | null> {
  const identity = parseConversationKey(key);
  if (identity.kind !== 'group') throw Error('Group required');
  const cacheKey = JSON.stringify([key, memberId, turnId]);
  const old = cache.get(cacheKey); if (old) return old;
  const detail = await sharedHistory(key);
  const member = detail.conversation.participants.find(m => m.memberId === memberId);
  if (!member || !('events' in detail)) return null;
  const sessions = await roomSessions(member.profile, identity.id);
  if (sessions.length !== 1) return null;
  const history = await sharedHistory(conversationKey('solo', sessions[0].id, member.profile));
  const trace = sliceRoomTrace(detail.events ?? [], history.messages, memberId, turnId);
  if (trace) { if (cache.size >= 128) cache.delete(cache.keys().next().value!); cache.set(cacheKey, trace); }
  return trace;
}
