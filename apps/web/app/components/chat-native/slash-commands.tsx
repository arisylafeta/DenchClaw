'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Popover } from '@base-ui/react/popover'
import { ChevronRight } from 'lucide-react'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { slashSection, slashVisible, type SlashCompletion, type SlashItem } from '@/lib/hermes-chat/slash-commands'

export function NativeSlashComposer({ chat, text, enabled, busy, setText, run, children }: {
  chat: NativeHermesChat; text: string; enabled: boolean; busy: boolean
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
    <Popover.Root open={open} onOpenChange={next => { if (!next) {setDismissed(text)} }}>
      {children}
      <Popover.Portal>
        <Popover.Positioner anchor={anchor?.closest<HTMLElement>('[data-chat-drop-target]') ?? anchor} side="top" align="start" sideOffset={8} collisionPadding={16} className="isolate z-[10000] outline-none">
          <Popover.Popup initialFocus={false} finalFocus={false} className="w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-2xl bg-[var(--color-surface)] text-[var(--color-text)] shadow-[0_12px_40px_rgba(0,0,0,0.18),0_2px_6px_rgba(0,0,0,0.08)] outline-none">
            <div className="flex items-center gap-2 px-3 pt-3 pb-2 text-[13px] text-[var(--color-text-secondary)]"><span>{argumentStage ? 'Options' : 'Commands'}{groups.length ? ` (${groups.reduce((count, group) => count + group.items.length, 0)})` : ''}</span>{(loading || items.length > 0) && <span className="ml-auto text-[11px]">{loading ? 'Searching…' : 'Tab completes · Enter runs'}</span>}</div>
            <div id={listId} role="listbox" aria-label="Slash commands" className="max-h-[min(23.5rem,45vh)] overflow-y-auto px-1.5 pb-1.5">
              {!groups.length && <p role="status" className="px-2.5 py-3 text-xs text-[var(--color-text-secondary)]">{error || (loading ? 'Loading commands…' : 'No matching commands')}</p>}
              {groups.map(group => <section key={group.name} role="group" aria-label={group.name}>
                <button type="button" aria-expanded={!collapsed[group.name]} onMouseDown={event => event.preventDefault()} onClick={() => { setCollapsed(previous => ({ ...previous, [group.name]: !previous[group.name] })); setSelected(0) }} className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"><ChevronRight aria-hidden className={`size-3 ${collapsed[group.name] ? '' : 'rotate-90'}`} /><span>{group.name}</span><span className="ml-auto font-normal tabular-nums">{group.items.length}</span></button>
                {!collapsed[group.name] && group.items.map(item => {
                  const index = rowIndex++
                  return <button id={`${listId}-${index}`} key={`${item.text}-${index}`} type="button" role="option" aria-selected={activeIndex === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setSelected(index)} onClick={() => pick(item, true)} className={`flex min-h-11 w-full flex-col rounded-lg py-1.5 pr-3 pl-6 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${activeIndex === index ? 'bg-[var(--color-surface-hover)]' : 'hover:bg-[var(--color-surface-hover)]'}`}>
                    <span className="text-[13px] font-medium">{item.display || item.text}</span><span title={item.meta} className="w-full truncate text-xs text-[var(--color-text-secondary)]">{item.meta}</span>
                  </button>
                })}
              </section>)}
            </div>
            {completion?.catalog?.warning && <p className="px-3 pb-2 text-xs text-[var(--color-text-secondary)]">{completion.catalog.warning}</p>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  </div>
}
