// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialReconcileState, applySnapshot, beginHydration } from '@/lib/hermes-chat/reconcile'
import { reduce } from '@/lib/hermes-chat/reducer'
import type { GatewayChatSnapshot } from '@/lib/hermes-chat/snapshot'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { NativeModelControls } from './model-controls'

const options = { model: 'small', provider: 'openai', providers: [{ slug: 'openai', name: 'OpenAI', models: ['small', 'expensive'] }], reasoning: { value: 'medium' } }
const context = { now: () => 10, id: () => 'id' }
function chat() {
  return { state: initialReconcileState(null, 'main:chat'), connection: 'connected', readOnly: null, setModel: vi.fn().mockResolvedValue({ value: 'expensive' }), setReasoning: vi.fn().mockResolvedValue({ value: 'high' }) } as unknown as NativeHermesChat
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => options })))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('native composer model controls', () => {
  const open = async (name: string) => { fireEvent.click(screen.getByRole('button', { name })); }
  it('shows current values on the pills, groups models by provider and applies thinking', async () => {
    const api = chat()
    render(<NativeModelControls conversationKey="main:chat" chat={api} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('small'))
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveTextContent('Medium')
    expect(fetch).toHaveBeenCalledWith('/api/hermes/conversations/main%3Achat/model-options', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    await open('Model')
    expect(await screen.findByText('OpenAI')).toBeInTheDocument()
    expect(screen.getByRole('menuitemradio', { name: 'expensive' })).toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    await open('Thinking')
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'High' }))
    await waitFor(() => expect(api.setReasoning).toHaveBeenCalledWith('high'))
  })
  it('requires explicit expensive-model confirmation and resends the exact selection', async () => {
    const api = chat()
    vi.mocked(api.setModel).mockResolvedValueOnce({ confirm_required: true, confirm_message: 'This model costs more.' }).mockResolvedValueOnce({ value: 'expensive' })
    render(<NativeModelControls conversationKey="main:chat" chat={api} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled())
    await open('Model')
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'expensive' }))
    expect(await screen.findByText('This model costs more.')).toBeInTheDocument()
    expect(api.setModel).toHaveBeenCalledWith('expensive', 'openai', false)
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    await waitFor(() => expect(api.setModel).toHaveBeenLastCalledWith('expensive', 'openai', true))
    await waitFor(() => expect(screen.queryByText('This model costs more.')).not.toBeInTheDocument())
  })
  it('cancels confirmation without changing the model', async () => {
    const api = chat()
    vi.mocked(api.setModel).mockResolvedValue({ confirm_required: true })
    render(<NativeModelControls conversationKey="main:chat" chat={api} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled())
    await open('Model')
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'expensive' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(api.setModel).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('small')
  })
  it('follows session.info values, says changes apply next turn and disables read-only controls', async () => {
    const api = chat()
    const view = render(<NativeModelControls conversationKey="main:chat" chat={api} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled())
    api.state = { ...api.state, ...reduce(api.state, { type: 'session.info', payload: { model: 'expensive', provider: 'openai', reasoning_effort: 'ultra', reasoning_effort_wire: 'max', running: true } }, context) }
    view.rerender(<NativeModelControls conversationKey="main:chat" chat={api} />)
    expect(screen.getByRole('button', { name: 'Model' })).toHaveTextContent('expensive')
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveTextContent('Ultra')
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('title', 'Thinking: Ultra (sends max on this route)')
    await open('Thinking')
    expect(await screen.findByText('Applies from the next turn')).toBeInTheDocument()
    api.readOnly = { source: 'cron' }
    view.rerender(<NativeModelControls conversationKey="main:chat" chat={api} />)
    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeDisabled()
  })
  it('keeps unavailable controls disabled and allows a catalog retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'session_not_live' }) } as Response)
    render(<NativeModelControls conversationKey="main:chat" chat={chat()} />)
    expect(screen.getByRole('button', { name: 'Model' })).toBeDisabled()
    expect(await screen.findByText('session_not_live')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled())
  })
  it('retains session settings through transcript hydration', () => {
    let state = initialReconcileState(null, 'main:chat')
    state = { ...state, ...reduce(state, { type: 'session.info', payload: { model: 'small', provider: 'openai', reasoning_effort: 'high' } }, context) }
    state = beginHydration(state)
    const snapshot = { key: 'main:chat', conversation: { id: 'chat', profile: 'main', title: 'Chat', working: false }, messages: [], running: false, pendingRequests: [], generation: 0, seq: 1 } satisfies GatewayChatSnapshot
    expect(applySnapshot(state, snapshot, state.loadToken, context)).toMatchObject({ model: 'small', provider: 'openai', reasoningEffort: 'high' })
  })
})
