import type { Usage } from './events'

export function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens))
  return `${Number((tokens / 1000).toFixed(1))}k`
}

/** Context occupancy is not the cumulative input/output token bill. */
export function contextWindowUsage(usage: Usage | null | undefined) {
  const used = usage?.context_used
  const total = usage?.context_max
  if (typeof used !== 'number' || typeof total !== 'number' || !Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total <= 0) return null
  return { used, total, percent: used / total * 100, estimated: usage?.context_estimated === true,
    label: `${formatContextTokens(used)} / ${formatContextTokens(total)}` }
}
