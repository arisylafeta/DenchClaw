/**
 * Hermes writes system events (finished background subagents, watcher pings, resumes, steers, model switches)
 * as `user` rows. They are not the user's words and must not render as the user's bubble.
 */
export type NoticeKind = 'delegation' | 'notification' | 'resume' | 'steer' | 'model'
export interface Notice { kind: NoticeKind; text: string; details?: string }

const KINDS: Record<string, NoticeKind> = {
  async_delegation_complete: 'delegation', internal_notification: 'notification', auto_continue: 'resume', steer: 'steer', model_switch: 'model',
}
const FALLBACK: Record<NoticeKind, string> = {
  delegation: 'A background task finished', notification: 'Background update', resume: 'Hermes resumed an interrupted turn', steer: 'You steered the agent', model: 'Model changed',
}
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
  const kind = typed ?? legacy
  if (!kind) return null
  const display = typeof readMetadata(row.displayMetadata).display_text === 'string' ? String(readMetadata(row.displayMetadata).display_text) : ''
  let summary = display
  if (!summary && kind === 'delegation') {
    const task = /--- [^\n]*TASK \d+\/\d+: ([^\n]*?) \(status=(\w+)/.exec(text)
    if (task) summary = `Subagent task ${task[2] === 'completed' ? 'completed' : task[2]}: ${task[1]}`
  }
  // A steer row's text is the user's own instruction: show it, not a generic label.
  if (kind === 'steer' && text.trim()) summary = `Steered: ${text}`
  return { kind, text: clip(summary || FALLBACK[kind]), ...(text.trim() ? { details: text } : {}) }
}
