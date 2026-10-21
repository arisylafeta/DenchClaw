/**
 * Hermes writes system events (finished background subagents, watcher pings, resumes, steers, model switches)
 * as `user` rows. They are not the user's words and must not render as the user's bubble.
 */
export type NoticeKind = 'delegation' | 'notification' | 'resume' | 'steer' | 'model' | 'process' | 'invite'
export interface Notice { kind: NoticeKind; text: string; details?: string; tone?: 'error'; key?: string; pending?: boolean }

const KINDS: Record<string, NoticeKind> = {
  async_delegation_complete: 'delegation', internal_notification: 'notification', auto_continue: 'resume', steer: 'steer', model_switch: 'model', background_process: 'process', process_complete: 'process',
}
const FALLBACK: Record<NoticeKind, string> = {
  delegation: 'A background task finished', notification: 'Background update', resume: 'Hermes resumed an interrupted turn', steer: 'You steered the agent', model: 'Model changed', process: 'Background process update', invite: 'An agent was invited into this chat',
}
/** Hermes wraps a mid-turn steer in an out-of-band marker; only the user's words matter. */
const OOB_OPEN = /^\s*\[OUT-OF-BAND USER MESSAGE[^\]\n]*\]\s*/
const OOB_CLOSE = /\s*\[\/OUT-OF-BAND USER MESSAGE\]\s*$/
export const stripSteerEnvelope = (text: string): string => text.replace(OOB_OPEN, '').replace(OOB_CLOSE, '').trim()
/** The user's own words in a steer row: envelope and appended process results removed. */
export const steerOwnText = (text: string): string => { if (!OOB_OPEN.test(text)) return text; const body = stripSteerEnvelope(text); const tail = PROCESS_TAIL.exec(`\n${body}`); return tail ? body.slice(0, Math.max(0, tail.index - 1)).trim() : body }
/** A steer can arrive carrying finished background-process results; those are not the user's words. */
export const PROCESS_TAIL = /\n+(?:\[?IMPORTANT: (\d+) background processes? completed\.[^\n]*Treat these results as one batch|\[IMPORTANT: Background process \S+ )/
/** First line of an /invite handoff, written by inviteHandoff in hermes-native.ts. */
export const INVITE_HEAD = /^\[ROOM INVITE host=(\S+) session=(\S+) invitee=(\S+)\]\n/
const clip = (text: string, max = 140) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line }
const readMetadata = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {} } catch { return {} } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
/** Typed rows use Hermes' display_kind and display_text; untyped legacy rows are recognised by their prefix. */
export function noticeForRow(row: { role: string; displayKind?: string | null; displayMetadata?: unknown; text?: string }): Notice | null {
  if (row.role !== 'user') return null
  const text = row.text ?? ''
  const typed = row.displayKind ? KINDS[row.displayKind] : undefined
  const legacy = !typed && /^\[ASYNC DELEGATION BATCH COMPLETE/.test(text) ? 'delegation' : undefined
  const invite = !typed && !legacy && INVITE_HEAD.test(text) ? 'invite' as const : undefined
  const process = !typed && !legacy && !invite && !legacy && /^\[IMPORTANT: (?:Background process \S+|\d+ background processes? completed)/.test(text) ? 'process' as const : undefined
  const wrapped = !typed && !legacy && !invite && !process && OOB_OPEN.test(text) ? 'steer' as const : undefined
  const kind = typed ?? legacy ?? invite ?? process ?? wrapped
  if (!kind) return null
  const display = typeof readMetadata(row.displayMetadata).display_text === 'string' ? String(readMetadata(row.displayMetadata).display_text) : ''
  let summary = display
  if (!summary && kind === 'delegation') {
    const task = /--- [^\n]*TASK \d+\/\d+: ([^\n]*?) \(status=(\w+)/.exec(text)
    if (task) summary = `Subagent task ${task[2] === 'completed' ? 'completed' : task[2]}: ${task[1]}`
  }
  if (!summary && kind === 'process') {
    const batch = /^\[IMPORTANT: (\d+) background processes? completed/.exec(text)
    if (batch) summary = `${batch[1]} background processes completed`
    const head = /^\[IMPORTANT: Background process (\S+) ([^\n(]*?)(?: \(exit code (-?\d+)\))?\.?\n/.exec(text)
    const command = /^Command: ([^\n]*)/m.exec(text)?.[1]
    if (!batch && head) summary = `Background process ${head[2].trim()}${head[3] && head[3] !== '0' ? ` (exit ${head[3]})` : ''}${command ? `: ${command}` : ''}`
  }
  if (!summary && kind === 'invite') {
    const head = INVITE_HEAD.exec(text)
    if (head) summary = `Invited ${head[3]} · from ${head[1]} chat`
  }
  // A steer row's text is the user's own instruction: show it, not a generic label.
  const steerFull = kind === 'steer' ? stripSteerEnvelope(text) : ''
  const tail = PROCESS_TAIL.exec(`\n${steerFull}`)
  const steerText = tail ? steerFull.slice(0, Math.max(0, tail.index - 1)).trim() : steerFull
  if (steerText) summary = `Steered: ${steerText}`
  else if (tail) { const count = tail[1] ? Number(tail[1]) : 1; summary = `${count} background process${count === 1 ? '' : 'es'} completed` }
  const details = kind === 'invite' ? text.replace(INVITE_HEAD, '').trim() : kind === 'steer' ? (steerFull.length > 140 || steerFull.includes('\n') ? steerFull : '') : text.trim() ? text : ''
  return { kind: kind === 'steer' && !steerText && tail ? 'process' : kind, text: clip(summary || FALLBACK[kind]), ...(details ? { details } : {}) }
}
