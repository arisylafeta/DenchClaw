'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { dockClass } from './requests'
import { ChevronRight } from 'lucide-react'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { slashSection, slashVisible, type SlashCompletion, type SlashItem } from '@/lib/hermes-chat/slash-commands'

export interface CommandStatusLine { text: string; tone: 'info' | 'error' | 'pending'; onCancel?: () => void }
export function NativeSlashComposer({ chat, text, enabled, busy, setText, run, status, children }: {
  chat: NativeHermesChat; text: string; enabled: boolean; busy: boolean; status?: CommandStatusLine
  setText(text: string): void; run(command: string): void; children: ReactNode
}) {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const [completion, setCompletion] = useState<SlashCompletion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const complete = useRef(chat.completeSlash)
  const completionText = useRef('')
  complete.current = chat.completeSlash
  const listId = useId()
  const open = enabled && text.startsWith('/') && !text.includes('\n') && dismissed !== text && !busy
  useEffect(() => {
    setSelected(0)
    setError(null)
    if (!open) { setCompletion(null); return }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(() => {
      void complete.current(text, controller.signal).then(value => {
        if (!controller.signal.aborted) { completionText.current = text; setCompletion(value); setLoading(false) }
      }).catch(cause => {
        if (!controller.signal.aborted) { setCompletion(null); setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) }
      })
    }, 80)
    return () => { clearTimeout(timer); controller.abort() }
  }, [text, open])
  const argumentStage = (completion?.replace_from ?? 1) > 1
  const groups = ['Session', 'Model', 'Tools', 'Skills', 'Plugins'].map(name => ({
    name, items: (completion?.items ?? []).filter(item => slashVisible(argumentStage ? text : item.text, completion?.catalog) && slashSection(argumentStage ? { ...item, text, kind: 'command' } : item, completion?.catalog ?? {}) === name),
  })).filter(group => group.items.length)
  const items = groups.flatMap(group => collapsed[group.name] ? [] : group.items)
  const activeIndex = Math.min(selected, Math.max(0, items.length - 1))
  useEffect(() => {
    if (open) {document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })}
  }, [activeIndex, listId, open])
  function pick(item: SlashItem, execute: boolean) {
    if (completionText.current !== text) { return }
    // Hermes argument completions contain only the replacement suffix.
    const from = completion?.replace_from ?? 0
    const value = from > 1 ? text.slice(0, from) + item.text : item.text.startsWith('/') ? item.text : `/${item.text}`
    if (execute) { setDismissed(text); run(value) }
    else { setDismissed(null); setText(`${value}${value.endsWith(' ') ? '' : ' '}`) }
  }
  let rowIndex = 0
  const total = groups.reduce((count, group) => count + group.items.length, 0)
  return <div ref={setAnchor} onKeyDownCapture={event => {
    if (!open || event.nativeEvent.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {return}
    if (!['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {return}
    if (event.key === 'Enter' && (!items.length || completionText.current !== text)) {return}
    event.preventDefault(); event.stopPropagation()
    if (event.key === 'Escape') { setDismissed(text); return }
    if (event.key === 'ArrowDown') {setSelected(items.length ? (activeIndex + 1) % items.length : 0)}
    if (event.key === 'ArrowUp') {setSelected(items.length ? (activeIndex + items.length - 1) % items.length : 0)}
    if ((event.key === 'Tab' || event.key === 'Enter') && items[activeIndex]) {pick(items[activeIndex], event.key === 'Enter')}
  }}>
    {/* Docks on top of the input and shares its surface, like questions and approvals. */}
    {open && <section aria-label="Commands" data-slash-dock className={`${dockClass} px-3 pt-3 pb-1`}>
      <div className="mb-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
        <span className="font-medium">{argumentStage ? 'Options' : 'Commands'}{total ? ` · ${total}` : ''}</span>
        {(loading || items.length > 0) && <span className="ml-auto">{loading ? 'Searching…' : 'Tab completes · Enter runs · Esc closes'}</span>}
      </div>
      <div id={listId} role="listbox" aria-label="Slash commands" className="max-h-[min(18rem,35dvh)] overflow-y-auto">
        {!groups.length && <p role="status" className={`py-2 text-xs ${error ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}>{error || (loading ? 'Loading commands…' : 'No matching commands')}</p>}
        {groups.map(group => <section key={group.name} role="group" aria-label={group.name}>
          <button type="button" aria-expanded={!collapsed[group.name]} onMouseDown={event => event.preventDefault()} onClick={() => { setCollapsed(previous => ({ ...previous, [group.name]: !previous[group.name] })); setSelected(0) }} className="flex w-full items-center gap-1 rounded-md px-1 py-1 text-left text-[11px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"><ChevronRight aria-hidden className={`size-3 ${collapsed[group.name] ? '' : 'rotate-90'}`} /><span>{group.name}</span><span className="ml-auto font-normal tabular-nums">{group.items.length}</span></button>
          {!collapsed[group.name] && group.items.map(item => {
            const index = rowIndex++
            return <button id={`${listId}-${index}`} key={`${item.text}-${index}`} type="button" role="option" aria-selected={activeIndex === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => pick(item, true)} className={`flex min-h-9 w-full items-baseline gap-3 rounded-md px-2 py-1 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${activeIndex === index ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
              <span className="shrink-0 text-[13px] font-medium">{item.display || item.text}</span><span title={item.meta} className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]">{item.meta}</span>
            </button>
          })}
        </section>)}
      </div>
      {completion?.catalog?.warning && <p className="pt-1 text-[11px] text-[var(--color-text-muted)]">{completion.catalog.warning}</p>}
    </section>}
    {status && <p role={status.tone === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 px-3 pb-1 text-[11px] ${status.tone === 'error' ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}`}><span className="min-w-0 break-words">{status.text}</span>{status.onCancel && <button type="button" onClick={status.onCancel} aria-label="Cancel queued command" className="shrink-0 rounded px-1 underline-offset-2 hover:underline focus-visible:outline-2">Cancel</button>}</p>}
    {children}
  </div>
}
