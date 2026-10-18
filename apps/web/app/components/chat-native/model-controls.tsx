'use client'

import { useEffect, useState } from 'react'
import { Brain, ChevronDown, Loader2 } from 'lucide-react'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { ProviderIcon } from '../chat-model-selector'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu'

type Provider = { slug: string; name?: string; models: string[]; capabilities?: Record<string, { reasoning?: boolean; can_disable_reasoning?: boolean }> }
type ModelOptions = { model: string; provider: string; providers: Provider[]; reasoning?: { value?: string } }

const EFFORT_LABEL: Record<string, string> = {
  none: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra',
}
const EFFORTS = Object.keys(EFFORT_LABEL)
/** Same shape as the platform composer pills: quiet bordered capsule, icon + label. */
const PILL = 'inline-flex h-7 min-w-0 max-w-[14rem] shrink items-center gap-1.5 rounded-full border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-accent)] disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5 [&>svg]:shrink-0'
const MENU = 'min-w-[14rem] max-w-[20rem] p-1.5'

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
  const wire = chat.state.reasoningEffortWire
  const locked = disabled || !!chat.readOnly || chat.connection !== 'connected' || saving || !options || !!confirmation
  const capabilities = options?.providers.find(row => row.slug === provider)?.capabilities?.[model]
  const nextTurn = chat.state.busy ? <p className="px-2 pb-1 text-[11px] text-[var(--color-text-muted)]">Applies from the next turn</p> : null
  const changeModel = async (nextModel: string, nextProvider: string, confirm = false) => {
    setSaving(true); setError(null)
    try {
      const result = await chat.setModel(nextModel, nextProvider, confirm)
      setConfirmation(result.confirm_required ? { model: nextModel, provider: nextProvider, message: String(result.confirm_message || result.warning || 'This model costs more. Switch anyway?') } : null)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSaving(false) }
  }
  const changeEffort = (next: string) => {
    setSaving(true); setError(null)
    void chat.setReasoning(next).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setSaving(false))
  }

  if (confirmation) {
    return <div role="alert" className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--color-text-secondary)]">
      <span className="min-w-0 truncate" title={confirmation.message}>{confirmation.message}</span>
      <button type="button" className={PILL} disabled={saving} onClick={() => void changeModel(confirmation.model, confirmation.provider, true)}>Switch model</button>
      <button type="button" className={PILL} disabled={saving} onClick={() => setConfirmation(null)}>Cancel</button>
    </div>
  }
  return <div className="flex min-w-0 items-center gap-1" aria-label="Session model settings">
    <DropdownMenu>
      <DropdownMenuTrigger className={PILL} disabled={locked} aria-label="Model" title={model ? `${model} via ${provider}` : 'Model'}>
        {model ? <ProviderIcon provider={iconProvider(provider, model)} className="size-3.5 shrink-0" /> : null}
        <span className="min-w-0 truncate">{model || (error ? 'Model unavailable' : 'Loading model…')}</span>
        {saving ? <Loader2 className="animate-spin" aria-hidden /> : <ChevronDown aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className={MENU}>
        {nextTurn}
        <DropdownMenuRadioGroup value={JSON.stringify([provider, model])} onValueChange={value => {
          const [nextProvider, nextModel] = JSON.parse(String(value)) as [string, string]
          if (nextModel !== model || nextProvider !== provider) { void changeModel(nextModel, nextProvider) }
        }}>
          {options?.providers.filter(row => row.models.length).map((row, index) => <DropdownMenuGroup key={row.slug}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[11px] text-[var(--color-text-muted)]">{row.name || row.slug}</DropdownMenuLabel>
            {row.models.map(name => <DropdownMenuRadioItem key={name} value={JSON.stringify([row.slug, name])}>
              <ProviderIcon provider={iconProvider(row.slug, name)} className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">{name}</span>
            </DropdownMenuRadioItem>)}
          </DropdownMenuGroup>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenuTrigger className={PILL} disabled={locked || capabilities?.reasoning === false} aria-label="Thinking"
        title={wire && wire !== effort ? `Thinking: ${EFFORT_LABEL[effort] ?? effort} (sends ${wire} on this route)` : 'Thinking'}>
        <Brain aria-hidden />
        <span className="truncate">{EFFORT_LABEL[effort] ?? (effort || 'Thinking')}</span>
        <ChevronDown aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-[10rem] p-1.5">
        {nextTurn}
        <DropdownMenuRadioGroup value={effort} onValueChange={value => { if (value !== effort) { changeEffort(String(value)) } }}>
          {EFFORTS.filter(value => value !== 'none' || capabilities?.can_disable_reasoning !== false).map(value =>
            <DropdownMenuRadioItem key={value} value={value}>{EFFORT_LABEL[value]}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span role="alert" className="min-w-0 truncate text-[11px] text-[var(--color-text-muted)]" title={error}>
      {error}{!options && <button type="button" className="ml-1.5 underline" onClick={() => setReload(value => value + 1)}>Retry</button>}
    </span>}
  </div>
}
