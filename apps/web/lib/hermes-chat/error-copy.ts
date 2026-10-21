import type { ErrorSurface } from './events'

/** Reader-facing copy for a Hermes or client error. The raw text stays available as `detail`. */
export interface ErrorCopy { title: string; hint?: string; detail?: string }

const BY_CODE: Record<string, (who: string) => ErrorCopy> = {
  content_policy_blocked: who => ({ title: `${who} declined this request`, hint: 'Its content filter blocked the reply. Rephrase the request, or split it into smaller steps.' }),
  provider_policy_blocked: who => ({ title: `${who} declined this request`, hint: 'The provider policy blocked the reply. Rephrase the request or switch model.' }),
  upstream_blocked: who => ({ title: `${who} blocked the request`, hint: 'Rephrase the request or switch model.' }),
  rate_limited: who => ({ title: `${who} is rate limiting requests`, hint: 'Wait a moment, then retry.' }),
  at_capacity: who => ({ title: `${who} is over capacity`, hint: 'Retry shortly or switch model.' }),
  outage: who => ({ title: `${who} is having an outage`, hint: 'Retry shortly or switch model.' }),
  context_overflow: () => ({ title: 'This conversation is too long for the model', hint: 'Run /compress, or start a new chat.' }),
  auth: who => ({ title: `Signing in to ${who} failed`, hint: 'The credentials may have expired. Ask an admin to reconnect the provider.' }),
  auth_permanent: who => ({ title: `Signing in to ${who} failed`, hint: 'Ask an admin to reconnect the provider.' }),
  billing: who => ({ title: `${who} refused the request for billing reasons`, hint: 'Check the provider account balance.' }),
  billing_unverified: who => ({ title: `${who} needs billing verification`, hint: 'Check the provider account.' }),
  model_not_found: () => ({ title: 'The selected model is not available', hint: 'Pick another model.' }),
  timeout: who => ({ title: `${who} took too long to answer`, hint: 'Retry the request.' }),
  truncated: () => ({ title: 'The reply was cut off', hint: 'Retry, or ask for a shorter answer.' }),
  empty_response: () => ({ title: 'The model returned an empty reply', hint: 'Retry the request.' }),
  invalid_response: () => ({ title: 'The model returned a reply Hermes could not read', hint: 'Retry the request.' }),
  format_error: () => ({ title: 'The request was rejected as malformed' }),
  session_busy: () => ({ title: 'Hermes is still busy with the previous turn', hint: 'Wait for it to finish, then send again.' }),
  loop_error: () => ({ title: 'Hermes hit an internal error', hint: 'Retry, or start a new chat if it keeps happening.' }),
  interpreter_shutdown: () => ({ title: 'Hermes restarted during this turn', hint: 'Send the message again.' }),
  ssl_cert_verification: who => ({ title: `Could not verify ${who}'s certificate` }),
}
/** Client and gateway transport errors, by the code the API returns. */
const BY_CLIENT_CODE: Record<string, ErrorCopy> = {
  gateway_unavailable: { title: 'Lost connection to Hermes', hint: 'Reconnect before sending another message.' },
  gateway_transport: { title: 'This chat cannot accept messages here', hint: 'Open it again from the sidebar.' },
  sse_transport: { title: 'This chat uses an older transport', hint: 'Start a new chat to continue.' },
  automation_read_only: { title: 'Automation chats are read-only', hint: 'Continue in a new chat.' },
  prompt_failed: { title: 'Hermes could not start this turn', hint: 'Send the message again.' },
}

const providerName = (surface?: ErrorSurface | null) => {
  const label = surface?.provider_label ?? surface?.provider
  if (typeof label !== 'string' || !label) return 'The model'
  return label.charAt(0).toUpperCase() + label.slice(1)
}
/** `code: detail` or `Error code: 429` strings carry the code when no surface came with them. */
function codeOf(message: string): string | undefined {
  const head = /^([a-z][a-z_]+):/.exec(message.trim())?.[1]
  if (head && (BY_CODE[head] || BY_CLIENT_CODE[head])) return head
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate_limited'
  if (/content.?filter|content_policy/i.test(message)) return 'content_policy_blocked'
  if (/context (?:length|window)|too many tokens|prompt is too long/i.test(message)) return 'context_overflow'
  if (/timed? ?out/i.test(message)) return 'timeout'
  return Object.keys(BY_CLIENT_CODE).find(code => message.includes(code))
}

export function describeError(message: string | undefined, surface?: ErrorSurface | null): ErrorCopy {
  const raw = (message ?? '').trim()
  const code = surface?.code && (BY_CODE[surface.code] || /^\d+$/.test(surface.code)) ? surface.code : codeOf(raw)
  const known = code === '429' ? BY_CODE.rate_limited(providerName(surface))
    : code && BY_CODE[code] ? BY_CODE[code](providerName(surface))
      : code && BY_CLIENT_CODE[code] ? BY_CLIENT_CODE[code]
        : surface?.layer === 'streaming' ? { title: 'The connection to the model dropped', hint: 'Retry the request.' }
          : surface?.layer === 'disk' ? { title: 'The server ran out of disk space' } : undefined
  if (known) {
    const detail = [raw, surface ? `${surface.layer} · ${surface.code}` : ''].filter(Boolean).join('\n')
    return { ...known, ...(detail ? { detail } : {}) }
  }
  // Unknown error: show its first line as the title and keep the rest folded.
  const [first = '', ...rest] = raw.split('\n')
  const title = first.length > 160 ? `${first.slice(0, 159)}…` : first
  const detail = [first.length > 160 || rest.length ? raw : '', surface ? `${surface.layer} · ${surface.code}` : ''].filter(Boolean).join('\n')
  return { title: title || 'Something went wrong', ...(detail ? { detail } : {}) }
}
