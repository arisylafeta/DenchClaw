import type { GoalSnapshot } from '../../vendor/hermes-gateway/gateway-contract.generated'
import { asRecord } from './events'

export type { GoalSnapshot }

/** Session control actions the goal card may run (the gateway's `session.control` allowlist). */
export const GOAL_ACTIONS = ['goal.pause', 'goal.resume', 'goal.clear', 'goal.unwait', 'subgoal.add', 'subgoal.remove'] as const
export type GoalAction = typeof GOAL_ACTIONS[number]

const text = (value: unknown) => typeof value === 'string' ? value : ''
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * Hermes persists GoalState in state_meta (`goal:<session>`) even when no live runtime can answer
 * `session.control.read`. Convert it to the same frontend-safe shape; a cleared goal is no goal.
 */
export function goalFromState(raw: unknown): GoalSnapshot | null {
  const state = asRecord(raw)
  const title = text(state.goal).trim()
  const status = text(state.status)
  if (!title || !status || status === 'cleared') return null
  const contract = asRecord(state.contract)
  const now = Date.now() / 1000
  const until = count(state.waiting_until)
  const reason = text(state.waiting_reason)
  const wait_barrier = until > now ? { type: 'until' as const, until_at: until, reason }
    : state.waiting_on_session != null ? { type: 'session' as const, target: String(state.waiting_on_session), reason }
      : state.waiting_on_pid != null ? { type: 'pid' as const, target: count(state.waiting_on_pid), reason } : null
  return {
    title, status, turns_used: count(state.turns_used), max_turns: count(state.max_turns) || 20,
    contract: Object.fromEntries(['outcome', 'verification', 'constraints', 'boundaries', 'stop_when'].map(key => [key, text(contract[key])])),
    subgoals: Array.isArray(state.subgoals) ? state.subgoals.filter((item): item is string => typeof item === 'string') : [],
    gates: Array.isArray(state.gates) ? state.gates.map(gate => {
      const row = asRecord(gate)
      return { command: text(row.command), timeout_seconds: count(row.timeout_seconds), max_retries: count(row.max_retries), attempts: count(row.attempts),
        last_exit_code: typeof row.last_exit_code === 'number' ? row.last_exit_code : null }
    }).filter(gate => gate.command) : [],
    ...(count(state.created_at) ? { created_at: count(state.created_at) } : {}),
    ...(count(state.last_turn_at) ? { updated_at: count(state.last_turn_at) } : {}),
    ...(text(state.paused_reason) ? { paused_reason: text(state.paused_reason) } : {}),
    ...(text(state.last_verdict) ? { last_verdict: text(state.last_verdict) } : {}),
    ...(text(state.last_reason) ? { last_reason: text(state.last_reason) } : {}),
    ...(wait_barrier ? { wait_barrier } : {}),
  }
}

/** The snapshot's goal, or null; anything malformed is treated as no goal. */
export function goalFromControl(control: unknown): GoalSnapshot | null {
  const goal = asRecord(asRecord(control).goal)
  return typeof goal.title === 'string' && goal.title && typeof goal.status === 'string' ? goal as unknown as GoalSnapshot : null
}

/** Hermes writes these as user rows between goal turns; they are not the user's words. */
export const GOAL_CONTINUATION = /^\[Continuing toward your standing goal(?: — ([^\]\n]*))?\]\n/

/** The judge's verdict line (`status.update` kind goal): `↻ Continuing toward goal (2/20): reason`. */
export function goalVerdict(raw: string): { verdict: 'continue' | 'done' | 'blocked' | 'wait' | 'paused' | 'other'; text: string; reason: string } {
  const line = raw.replace(/^[^\p{L}\p{N}[(]+/u, '').trim()
  const [head, ...rest] = line.split(/:\s+/)
  const reason = rest.join(': ').trim()
  const lower = head.toLowerCase()
  const verdict = lower.startsWith('continuing') ? 'continue' : lower.includes('achieved') || lower.includes('done') ? 'done'
    : lower.includes('blocked') ? 'blocked' : lower.includes('wait') ? 'wait' : lower.includes('pause') ? 'paused' : 'other'
  const turn = /\((\d+)\/(\d+)\)/.exec(head)
  const label = verdict === 'continue' && turn ? `Goal turn ${turn[1]} of ${turn[2]}` : verdict === 'done' ? 'Goal achieved'
    : verdict === 'blocked' ? 'Goal blocked' : verdict === 'wait' ? 'Goal waiting' : verdict === 'paused' ? 'Goal paused' : head
  return { verdict, text: reason ? `${label} · ${reason}` : label, reason }
}
