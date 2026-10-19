'use client'
import type { Usage } from '@/lib/hermes-chat/events'
import { contextWindowUsage } from '@/lib/hermes-chat/context-usage'

export function ContextUsage({ usage }: { usage?: Usage | null }) {
  const context = contextWindowUsage(usage)
  if (!context) return null
  const description = `${context.estimated ? 'Estimated context' : 'Context'}: ${context.used.toLocaleString('en-US')} / ${context.total.toLocaleString('en-US')} tokens (${context.percent.toFixed(1)}%)`
  return <span title={description} aria-label={description} tabIndex={0}
    className="hidden h-7 shrink-0 flex-col justify-center gap-0.5 rounded px-1.5 min-[420px]:inline-flex text-[10px] leading-tight whitespace-nowrap text-[var(--color-text-muted)] tabular-nums focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">
    <span>{context.label}</span>
    <span aria-hidden="true" className="h-0.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
      <span className="block h-full bg-current" style={{ width: `${Math.min(100, context.percent)}%` }} />
    </span>
  </span>
}
