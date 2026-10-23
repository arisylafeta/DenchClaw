// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
import { ownerAccess } from './access-fixture'
import { PromptDock } from '../../app/components/chat-native/prompt-dock'
import { conversationKey } from '../hermes-conversations'

class Source {
  static instance: Source
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  readyState = 1
  constructor() { Source.instance = this }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent) }) }
}
const key = conversationKey('solo', 'session', 'alpha')
const snapshot = (extra = {}) => ({ key, conversation: { id: 'session', profile: 'alpha', title: 'Synthetic', working: true, access: ownerAccess }, messages: [], running: true, generation: 1, seq: 0, pendingRequests: [], ...extra })
function Dock({ selected = key }: { selected?: string }) {
  const chat = useNativeHermesChat({ conversationKey: selected, enabled: true })
  return <><span>{chat.state.hydrating ? 'Loading history' : 'History ready'}</span><PromptDock state={chat.state} subagents={chat.subagents} callbacks={{ onApproval() {}, onClarify() {}, onSubagentTail() {}, onSubagentSteer() {}, onSubagentInterrupt() {}, onRetry() {} }} disabled={chat.state.hydrating} /></>
}
const start = (seq = 1, extra = {}) => Source.instance.emit('gw', { key, generation: 1, seq, type: 'subagent.start', payload: { subagent_id: 'child', goal: 'Research' }, ...extra })
beforeEach(() => { vi.stubGlobal('EventSource', Source); vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))) })
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('clears the stale running dock and count after an authoritative empty resync', () => {
  render(<Dock />)
  Source.instance.emit('snapshot', snapshot())
  start()
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
  Source.instance.emit('resync', { key })
  Source.instance.emit('snapshot', snapshot({ seq: 1, subagents: [] }))
  expect(screen.queryByText('1 subagent running')).toBeNull()
  expect(screen.queryByLabelText('Subagents')).toBeNull()
})

it('preserves a buffered start when the asynchronous empty list predates it', () => {
  render(<Dock />)
  Source.instance.emit('snapshot', snapshot())
  Source.instance.emit('resync', { key })
  start(2)
  Source.instance.emit('snapshot', snapshot({ seq: 1, subagents: [] }))
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
})

it('shows live subagents immediately while history is loading, then retains them after hydration', () => {
  render(<Dock />)
  start()
  expect(screen.getByText('Loading history')).toBeInTheDocument()
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
  Source.instance.emit('snapshot', snapshot())
  expect(screen.getByText('History ready')).toBeInTheDocument()
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
})

it('hydrates existing workers without waiting for a later progress event', () => {
  render(<Dock />)
  Source.instance.emit('snapshot', snapshot({ seq: 5, subagents: [{ subagent_id: 'child', goal: 'Research', status: 'running' }] }))
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
})

it('does not delay an ordinary post-hydration start or lose it on resync', () => {
  render(<Dock />)
  Source.instance.emit('snapshot', snapshot())
  start()
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
  Source.instance.emit('resync', { key })
  Source.instance.emit('snapshot', snapshot({ seq: 1 }))
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
})

it('orders buffered replay before deciding whether a finished worker is retired', () => {
  render(<Dock />)
  Source.instance.emit('gw', { key, generation: 1, seq: 2, type: 'subagent.complete', payload: { subagent_id: 'child', status: 'completed' } })
  Source.instance.emit('gw', { key, generation: 1, seq: 1, type: 'message.start', payload: {} })
  expect(screen.getByText('1 subagent finished')).toBeInTheDocument()
  Source.instance.emit('snapshot', snapshot())
  expect(screen.getByText('1 subagent finished')).toBeInTheDocument()
})

it('keeps a completed current-turn worker when the child list races ahead of replay', () => {
  render(<Dock />)
  Source.instance.emit('gw', { key, generation: 1, seq: 1, type: 'message.start', payload: {} })
  start(2)
  Source.instance.emit('gw', { key, generation: 1, seq: 3, type: 'subagent.complete', payload: { subagent_id: 'child', status: 'completed' } })
  Source.instance.emit('snapshot', snapshot({ seq: 0, subagents: [{ subagent_id: 'child', goal: 'Research', status: 'completed' }] }))
  expect(screen.getByText('1 subagent finished')).toBeInTheDocument()
})

it('keeps completion terminal through replay and stale snapshots, and never resurrects retired workers', () => {
  render(<Dock />)
  start()
  Source.instance.emit('gw', { key, generation: 1, seq: 2, type: 'subagent.complete', payload: { subagent_id: 'child', status: 'completed', summary: 'Done' } })
  expect(screen.getByText('1 subagent finished')).toBeInTheDocument()
  Source.instance.emit('snapshot', snapshot({ subagents: [{ subagent_id: 'child', goal: 'Research', status: 'running' }] }))
  expect(screen.getByText('1 subagent finished')).toBeInTheDocument()
  start(1, { replayed: true })
  expect(screen.queryByText('1 subagent running')).toBeNull()
  Source.instance.emit('gw', { key, generation: 1, seq: 3, type: 'message.start', payload: {} })
  expect(screen.queryByText('1 subagent finished')).toBeNull()
  Source.instance.emit('resync', { key })
  Source.instance.emit('snapshot', snapshot({ seq: 3, subagents: [{ subagent_id: 'child', goal: 'Research', status: 'running' }] }))
  expect(screen.queryByLabelText('Subagents')).toBeNull()
})

it('keeps quiet running workers after the event dedupe TTL, and ignores older generations during resync', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  render(<Dock />)
  Source.instance.emit('snapshot', snapshot())
  start()
  clock.mockReturnValue(301000)
  Source.instance.emit('resync', { key })
  start(2, { generation: 0, payload: { subagent_id: 'old-child', goal: 'Old task' } })
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Subagent: Old task' })).toBeNull()
  Source.instance.emit('snapshot', snapshot({ seq: 1, subagents: [{ subagent_id: 'child', status: 'running' }] }))
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
})

it('does not expose the previous conversation workers even for the first render after switching', () => {
  const frames: string[][] = []
  function Probe({ selected }: { selected: string }) {
    const chat = useNativeHermesChat({ conversationKey: selected, enabled: true })
    frames.push(chat.subagents.items.map(child => child.id))
    return null
  }
  const view = render(<Probe selected={key} />)
  Source.instance.emit('snapshot', snapshot())
  start()
  expect(frames.at(-1)).toEqual(['child'])
  frames.length = 0
  view.rerender(<Probe selected={conversationKey('solo', 'another-session', 'alpha')} />)
  expect(frames.every(frame => frame.length === 0)).toBe(true)
})

it('rejects foreign keys and sessions and clears workers on a profile/session switch', () => {
  const view = render(<Dock />)
  start(1, { key: conversationKey('solo', 'session', 'beta') })
  expect(screen.queryByText('1 subagent running')).toBeNull()
  Source.instance.emit('snapshot', snapshot())
  start(2, { session_id: 'other' })
  expect(screen.queryByText('1 subagent running')).toBeNull()
  start(3)
  expect(screen.getByText('1 subagent running')).toBeInTheDocument()
  view.rerender(<Dock selected={conversationKey('solo', 'session', 'beta')} />)
  expect(screen.queryByText('1 subagent running')).toBeNull()
  start(4)
  expect(screen.queryByText('1 subagent running')).toBeNull()
})
