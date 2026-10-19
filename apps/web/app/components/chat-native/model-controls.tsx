'use client'

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { Brain, Check, ChevronDown, ChevronRight, Loader2, Search, Zap } from 'lucide-react'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { ContextUsage } from './context-usage'
import { ProviderIcon } from '../chat-model-selector'

type Provider = { slug: string; name?: string; models: string[]; capabilities?: Record<string, { reasoning?: boolean; can_disable_reasoning?: boolean }> }
type ModelOptions = { model: string; provider: string; providers: Provider[]; reasoning?: { value?: string }; fast?: boolean }

// Limit picker choices without changing configured credentials or a running session.
const PICKER_PROVIDERS = new Set(['anthropic', 'openai', 'openai-codex', 'opencode', 'opencode-zen', 'opencode-go'])

const LEVELS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
] as const
/** Efforts set elsewhere (CLI, config) still read correctly on the trigger. */
const OTHER_EFFORT_LABEL: Record<string, string> = { none: 'Off', minimal: 'Minimal', max: 'Max', ultra: 'Ultra' }
const TRIGGER = 'inline-flex h-7 min-w-0 max-w-[14rem] shrink items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] data-[popup-open]:bg-[var(--color-surface-hover)] data-[popup-open]:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0'
const POPUP = 'rounded-2xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_12px_40px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.08)] outline-none'
const QUIET_BUTTON = 'inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] disabled:opacity-50'

/** Hermes provider slugs name the route (openai-codex, openrouter); the icon follows the model family. */
function iconProvider(provider: string, model: string): string {
  const name = `${provider} ${model}`.toLowerCase()
  if (/claude|anthropic/.test(name)) return 'anthropic'
  if (/gpt|openai|codex|\bo\d/.test(name)) return 'openai'
  if (/gemini|google/.test(name)) return 'google'
  if (/deepseek/.test(name)) return 'deepseek'
  if (/kimi|moonshot/.test(name)) return 'kimi'
  if (/minimax/.test(name)) return 'minimax'
  if (/mistral/.test(name)) return 'mistral'
  if (/llama|meta/.test(name)) return 'meta'
  return provider
}

function Panel({ side = 'top', children, className = '' }: { side?: 'top' | 'bottom'; children: ReactNode; className?: string }) {
  return <Popover.Portal>
    <Popover.Positioner side={side} align="start" sideOffset={8} className="isolate z-[10000] outline-none">
      <Popover.Popup className={`${POPUP} ${className}`}>{children}</Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
}

function ModelPicker({ options, model, provider, busy, disabled, saving, error, onPick }: {
  options: ModelOptions | null; model: string; provider: string; busy: boolean; disabled: boolean; saving: boolean; error: string | null
  onPick: (model: string, provider: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const needle = query.trim().toLowerCase()
  const groups = useMemo(() => (options?.providers ?? []).filter(row => PICKER_PROVIDERS.has(row.slug)).map(row => ({
    ...row, matches: needle ? row.models.filter(name => `${name} ${row.name ?? ''} ${row.slug}`.toLowerCase().includes(needle)) : row.models,
  })).filter(row => row.matches.length), [options, needle])
  return <Popover.Root open={open} onOpenChange={next => { setOpen(next); if (!next) { setQuery('') } }}>
    <Popover.Trigger className={TRIGGER} disabled={disabled} aria-label="Model" title={model ? `${model} via ${provider}` : 'Model'}>
      {model ? <ProviderIcon provider={iconProvider(provider, model)} className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate">{model || (error ? 'Model unavailable' : 'Loading model…')}</span>
      {saving ? <Loader2 className="animate-spin" aria-hidden /> : <ChevronDown aria-hidden />}
    </Popover.Trigger>
    <Panel className="flex w-[18rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Search className="size-3.5 shrink-0 text-[var(--color-text-muted)]" aria-hidden />
        <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search models"
          aria-label="Search models" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--color-text-muted)]" />
      </div>
      <div className="max-h-[min(22rem,var(--available-height))] overflow-y-auto px-1.5 pb-1.5" role="listbox" aria-label="Models">
        {groups.length === 0 && <p className="px-2.5 py-3 text-xs text-[var(--color-text-muted)]">{options ? 'No models match' : 'Loading models…'}</p>}
        {groups.map(row => {
          // The current provider opens by default; a search opens every group that matches.
          const sectionOpen = Boolean(needle) || (expanded[row.slug] ?? row.slug === provider)
          return <section key={row.slug} className="py-0.5">
            <button type="button" aria-expanded={sectionOpen} disabled={Boolean(needle)}
              onClick={() => setExpanded(previous => ({ ...previous, [row.slug]: !sectionOpen }))}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold tracking-wide text-[var(--color-text-muted)] uppercase hover:bg-[var(--color-surface-hover)] disabled:hover:bg-transparent">
              <ChevronRight className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${sectionOpen ? 'rotate-90' : ''}`} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.name || row.slug}</span>
              <span className="font-normal normal-case tabular-nums">{row.matches.length}</span>
            </button>
            {sectionOpen && row.matches.map(name => {
              const selected = name === model && row.slug === provider
              return <button key={name} type="button" role="option" aria-selected={selected}
                onClick={() => { setOpen(false); setQuery(''); if (!selected) { onPick(name, row.slug) } }}
                className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 pl-6 text-left text-[13px] hover:bg-[var(--color-surface-hover)] ${selected ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-secondary)]'}`}>
                <ProviderIcon provider={iconProvider(row.slug, name)} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {selected && <Check className="size-3.5 shrink-0 text-[var(--color-accent)]" aria-hidden />}
              </button>
            })}
          </section>
        })}
      </div>
      {busy && <p className="px-3 pt-1 pb-2.5 text-[11px] text-[var(--color-text-muted)]">Applies from the next turn</p>}
    </Panel>
  </Popover.Root>
}

function ThinkingPicker({ effort, wire, busy, disabled, onPick }: {
  effort: string; wire?: string | null; busy: boolean; disabled: boolean; onPick: (effort: string) => void
}) {
  const index = LEVELS.findIndex(level => level.value === effort)
  const label = LEVELS[index]?.label ?? OTHER_EFFORT_LABEL[effort] ?? (effort || 'Thinking')
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0
    if (!step) { return }
    event.preventDefault()
    const next = LEVELS[Math.min(LEVELS.length - 1, Math.max(0, (index < 0 ? 1 : index) + step))]
    if (next.value !== effort) { onPick(next.value) }
  }
  return <Popover.Root>
    <Popover.Trigger className={TRIGGER} disabled={disabled} aria-label="Thinking"
      title={wire && wire !== effort ? `Thinking: ${label} (sends ${wire} on this route)` : 'Thinking'}>
      <Brain aria-hidden />
      <span className="truncate">{label}</span>
      <ChevronDown aria-hidden />
    </Popover.Trigger>
    <Panel className="w-[17rem] max-w-[calc(100vw-2rem)] p-3.5">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13px] font-medium">Thinking</span>
        <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
      </div>
      <div role="radiogroup" aria-label="Thinking effort" onKeyDown={move} className="grid grid-cols-4 gap-1">
        {LEVELS.map((level, position) => {
          const filled = index >= 0 && position <= index
          const selected = position === index
          return <button key={level.value} type="button" role="radio" aria-checked={selected} aria-label={level.label}
            tabIndex={selected || (index < 0 && position === 1) ? 0 : -1}
            onClick={() => { if (!selected) { onPick(level.value) } }}
            className="group flex flex-col items-stretch gap-1.5 rounded-md pt-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]">
            <span className={`h-1.5 rounded-full transition-colors duration-150 motion-reduce:transition-none ${filled ? 'bg-[var(--color-accent-fill)]' : 'bg-[var(--color-surface-hover)] group-hover:bg-[var(--color-border)]'}`} />
            <span className={`text-[11px] ${selected ? 'font-medium text-[var(--color-text)]' : 'text-[var(--color-text-muted)] group-hover:text-[var(--color-text-secondary)]'}`}>{level.label}</span>
          </button>
        })}
      </div>
      {busy && <p className="mt-3 text-[11px] text-[var(--color-text-muted)]">Applies from the next turn</p>}
    </Panel>
  </Popover.Root>
}

/** Session-scoped model and thinking pickers for the composer toolbar; never change a profile's defaults. */
export function NativeModelControls({ conversationKey, chat, disabled = false }: {
  conversationKey: string; chat: NativeHermesChat; disabled?: boolean
}) {
  const [options, setOptions] = useState<ModelOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [saving, setSaving] = useState(false)
  const [confirmation, setConfirmation] = useState<{ model: string; provider: string; message: string } | null>(null)
  useEffect(() => {
    if (chat.connection !== 'connected') { return }
    const controller = new AbortController()
    setError(null)
    void fetch(`/api/hermes/conversations/${encodeURIComponent(conversationKey)}/model-options`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json()
        if (!response.ok) { throw new Error(result.error || 'Unable to load models') }
        if (!controller.signal.aborted) { setOptions(result) }
      }).catch(reason => { if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)) } })
    return () => controller.abort()
  }, [conversationKey, chat.connection, reload])
  const model = chat.state.model ?? options?.model ?? ''
  const provider = chat.state.provider ?? options?.provider ?? ''
  const effort = chat.state.reasoningEffort ?? options?.reasoning?.value ?? ''
  const locked = disabled || !!chat.readOnly || chat.connection !== 'connected' || saving || !options
  const capabilities = options?.providers.find(row => row.slug === provider)?.capabilities?.[model]
  const changeModel = async (nextModel: string, nextProvider: string, confirm = false) => {
    setSaving(true); setError(null)
    try {
      const result = await chat.setModel(nextModel, nextProvider, confirm)
      setConfirmation(result.confirm_required ? { model: nextModel, provider: nextProvider, message: String(result.confirm_message || result.warning || 'This model costs more. Switch anyway?') } : null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  const fast = chat.state.fast ?? options?.fast ?? false
  const toggleFast = () => {
    setSaving(true); setError(null)
    void chat.setFast(!fast).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setSaving(false))
  }
  const changeEffort = (next: string) => {
    setSaving(true); setError(null)
    void chat.setReasoning(next).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setSaving(false))
  }

  if (confirmation) {
    return <div role="alert" className="flex min-w-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
      <span className="min-w-0 truncate px-1" title={confirmation.message}>{confirmation.message}</span>
      <button type="button" className={QUIET_BUTTON} disabled={saving} onClick={() => void changeModel(confirmation.model, confirmation.provider, true)}>Switch model</button>
      <button type="button" className={QUIET_BUTTON} disabled={saving} onClick={() => setConfirmation(null)}>Cancel</button>
    </div>
  }
  return <div className="flex min-w-0 flex-wrap items-center gap-0.5" aria-label="Session model settings">
    <ContextUsage usage={chat.connection === 'connected' ? chat.state.usage : null} />
    <ModelPicker options={options} model={model} provider={provider} busy={chat.state.busy} disabled={locked} saving={saving} error={error}
      onPick={(nextModel, nextProvider) => void changeModel(nextModel, nextProvider)} />
    <ThinkingPicker effort={effort} wire={chat.state.reasoningEffortWire} busy={chat.state.busy}
      disabled={locked || capabilities?.reasoning === false} onPick={changeEffort} />
    <button type="button" aria-label="Fast mode" aria-pressed={fast} disabled={locked} onClick={toggleFast}
      title={fast ? 'Fast mode on: priority processing for this chat' : 'Fast mode off'}
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 ${fast ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}>
      <Zap className={`size-3.5 ${fast ? 'fill-current' : ''}`} aria-hidden />
    </button>
    {error && <span role="alert" className="min-w-0 truncate px-1 text-[11px] text-[var(--color-text-muted)]" title={error}>
      {error}{!options && <button type="button" className="ml-1.5 underline" onClick={() => setReload(value => value + 1)}>Retry</button>}
    </span>}
  </div>
}
