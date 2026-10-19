import { asRecord, stringValue, type GatewayEvent } from './events'
import type { Notice } from './notice'

const clip = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 140)
const labels: Record<string, string> = {
  'session.reclaimed': 'Session reclaimed', 'session.title': 'Title changed',
  'session.control.update': 'Session controls updated', 'session.resume_progress': 'Resuming session',
  'background.complete': 'Background task finished', 'btw.complete': 'Side question answered',
  'tool.output_risk': 'Risky tool output detected', 'approval.cancelled': 'Approval cancelled',
  'request.cancel': 'Request cancelled', 'connection.request': 'Connection requested',
  'connection.update': 'Connection updated', 'billing.step_up.verification': 'Billing verification required',
  'review.summary': 'Review finished',
}
/** Pure projection. No raw auth/connection payloads are copied into transcript details. */
export function eventNotice(event: GatewayEvent, previousInfo?: Record<string, unknown>): Notice | null {
  if (event.type === 'session.info') {
    if (!previousInfo) return null
    const p = asRecord(event.payload)
    const changes = ['model', 'branch', 'cwd'].filter(key => (typeof p[key] === 'string' || p[key] === null) && previousInfo[key] !== undefined && p[key] !== previousInfo[key])
    return changes.length ? { kind: changes.includes('model') ? 'model' : 'notification', text: clip(changes.map(key => `${key}: ${p[key] ?? 'none'}`).join(', ')) } : null
  }
  const p = asRecord(event.payload)
  const type = event.type
  if (type === 'status.update' || type === 'notice' || type === 'error') {
    const text = stringValue(p.text) || stringValue(p.message)
    if (!text.trim()) return null
    return { kind: 'notification', text: clip(text), details: text, tone: type === 'error' ? 'error' : undefined,
      key: type === 'status.update' ? `status:${stringValue(p.kind) || 'status'}` : undefined }
  }
  const label = labels[type]
  if (!label) return null
  const formatters: Record<string, () => string> = {
    'session.resume_progress': () => [p.phase, p.status, p.message].filter(value => typeof value === 'string' && value).join(': '),
    'tool.output_risk': () => [p.name, p.risk, ...(Array.isArray(p.findings) ? p.findings : [])].filter(value => typeof value === 'string' && value).join('\n'),
    'session.control.update': () => {
      const control = asRecord(p.control)
      return ['goal', 'loop', 'heartbeat'].map(key => `${key}: ${control[key] == null ? 'off' : typeof control[key] === 'string' ? control[key] : 'updated'}`).join(', ')
    },
  }
  const body = formatters[type]?.() || ['text', 'message', 'title', 'reason', 'detail', 'phase'].map(key => stringValue(p[key])).find(Boolean)
  return { kind: type === 'background.complete' || type === 'btw.complete' ? 'delegation' : 'notification',
    text: clip(body ? `${label}: ${body}` : label),
    ...(body ? { details: body } : {}),
    key: type === 'session.resume_progress' ? type : type.startsWith('connection.') ? `connection:${stringValue(p.op_id)}` : undefined }
}

export function slashNotice(command: string, text: string, state: 'done' | 'error' | 'pending' | 'cancelled' = 'done'): Notice {
  const name = command.trim().split(/\s+/)[0]
  return { kind: 'process', text: clip(`${state === 'pending' ? 'Queued' : state === 'cancelled' ? 'Cancelled' : state === 'error' ? 'Failed' : 'Ran'} ${name}${text ? `: ${text}` : ''}`),
    details: text || undefined, tone: state === 'error' ? 'error' : undefined, pending: state === 'pending', key: `slash:${command.trim()}` }
}
