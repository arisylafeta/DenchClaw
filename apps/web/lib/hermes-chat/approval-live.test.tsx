// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PromptDock } from '../../app/components/chat-native/prompt-dock'
import { useNativeHermesChat } from './use-native-chat'
import { getHermesEventsClient } from './events-client'
import { ownerAccess } from './access-fixture'
import frames from './fixtures/protected-file-approval.json'

// Frames recorded from a real Hermes gateway (session.create on a test profile, source "crm", a `patch` of
// SOUL.md): tool.start -> `approval` server request (protected_instruction_file, allow_session/allow_permanent
// false, timeout_s 60) -> request.cancel on timeout. Replayed through the same SSE shape the CRM server emits.
class FakeSource {
  static instance: FakeSource
  listeners: Record<string, ((event: MessageEvent) => void)[]> = {}
  readyState = 1
  constructor(readonly url: string) { FakeSource.instance = this }
  addEventListener(type: string, listener: (event: MessageEvent) => void) { (this.listeners[type] ??= []).push(listener) }
  close() { this.readyState = 2 }
  emit(type: string, data: unknown) { act(() => { for (const listener of this.listeners[type] ?? []) listener({ data: JSON.stringify(data) } as MessageEvent) }) }
}
type Frame = { request?: { id: string; method: string; params: Record<string, unknown> }; gw?: { type: string; seq: number; payload: Record<string, unknown> } }
beforeEach(() => { vi.stubGlobal('EventSource', FakeSource); vi.stubGlobal('fetch', vi.fn(async () => Response.json({}))) })
afterEach(() => { cleanup(); getHermesEventsClient().close(); vi.unstubAllGlobals() })

describe('protected-file approval from a live gateway', () => {
  it('stays pending from the request until request.cancel and renders a one-time card', () => {
    const { result } = renderHook(() => useNativeHermesChat({ conversationKey: 'k', enabled: true }))
    FakeSource.instance.emit('snapshot', { key: 'k', conversation: { id: 'k', profile: 'alpha', title: 'k', working: false, access: ownerAccess }, messages: [], generation: 1, seq: 0, pendingRequests: [], gateway: 'connected', running: false })
    const pending: number[] = []
    let card: ReturnType<typeof render> | undefined
    for (const frame of frames as Frame[]) {
      if (frame.request) FakeSource.instance.emit('request', { key: 'k', ...frame.request })
      else FakeSource.instance.emit('gw', { key: 'k', type: frame.gw!.type, seq: frame.gw!.seq, generation: 1, payload: frame.gw!.payload })
      pending.push(result.current.state.pendingRequests.length)
      if (frame.request) {
        const [request] = result.current.state.pendingRequests
        expect(request).toMatchObject({ kind: 'approval', id: frame.request.id })
        card = render(<PromptDock state={result.current.state} subagents={{ items: [] } as never} callbacks={{ onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() } as never} />)
      }
    }
    // Pending from the request until request.cancel (the gateway timeout), never before or after.
    expect(pending.join('')).toBe('0000010000')
    expect(card).toBeDefined()
  })

  it('offers only Run once and Deny when the gateway forbids session and permanent scopes', () => {
    const request = (frames as Frame[]).find(frame => frame.request)!.request!
    const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() } as never
    render(<PromptDock state={{ sessionId: 's', pendingRequests: [{ id: request.id, requestId: request.params.request_id as string, kind: 'approval', payload: request.params }] }} subagents={{ items: [] } as never} callbacks={callbacks} />)
    expect(screen.getByRole('region', { name: 'Approval required' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run once' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow for session' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Always allow' })).toBeNull()
    expect(screen.getByText(/within 60s/)).toBeInTheDocument()
  })
})
