// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { applyLive, initialReconcileState, placeSteer, submitOptimistic } from '@/lib/hermes-chat/reconcile'
import { NativeTranscript } from './native-transcript'
import { PromptDock } from './prompt-dock'
const callbacks = { onApproval: vi.fn(), onClarify: vi.fn(), onSubagentTail: vi.fn(), onSubagentSteer: vi.fn(), onSubagentInterrupt: vi.fn(), onRetry: vi.fn() }
let id = 0
const ctx = { now: () => 1000, id: () => `id-${++id}` }
it('renders accepted steering between completed work and the live continuation', () => {
  let state = { ...initialReconcileState('s', 's'), hydrating: false }
  state = applyLive(state, [{ type: 'message.start' }, { type: 'reasoning.delta', payload: { text: 'Before steering' } }], ctx)
  state = placeSteer(submitOptimistic(state, { clientId: 'steer', text: 'Change course' }), 'steer')
  state = applyLive(state, [{ type: 'reasoning.delta', payload: { text: 'After steering' } }], ctx)
  const { container } = render(<NativeTranscript state={state} callbacks={callbacks} />)
  const articles = [...container.querySelectorAll('article')]
  expect(articles).toHaveLength(3)
  expect(articles[0]).toHaveTextContent('Before steering')
  expect(articles[0].querySelector('details')).not.toHaveAttribute('open')
  expect(articles[1]).toHaveTextContent('Change course')
  expect(articles[2]).toHaveTextContent('After steering')
  expect(articles[2].querySelector('details')).toHaveAttribute('open')
  expect(screen.getAllByText(/^Thinking/)).toHaveLength(1)
})
it('keeps waiting messages out of the transcript and lists them flat in the dock until accepted', () => {
  const state = submitOptimistic({ ...initialReconcileState(), hydrating: false }, { clientId: 'queued', text: 'Next task' })
  const { container, rerender } = render(<><NativeTranscript state={state} queuedMessageIds={['queued']} callbacks={callbacks} /><PromptDock state={state} subagents={state.subagents} callbacks={callbacks} queued={[{ id: 'queued', text: 'Next task', steer: false }]} /></>)
  expect(container.querySelector('[aria-label="Native Hermes transcript"]')).not.toHaveTextContent('Next task')
  const row = container.querySelector('[data-queued-id="queued"]')!
  expect(row).toHaveTextContent('QueuedNext tasknext')
  expect(row.querySelector('svg')).not.toBeNull()
  rerender(<><NativeTranscript state={state} queuedMessageIds={[]} callbacks={callbacks} /><PromptDock state={state} subagents={state.subagents} callbacks={callbacks} /></>)
  expect(container.querySelector('[data-queue]')).toBeNull()
  expect(screen.getByText('Next task')).toBeInTheDocument()
})
