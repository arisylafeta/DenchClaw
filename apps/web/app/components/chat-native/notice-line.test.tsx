// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { NativeTranscript } from './native-transcript'
import { initialState, reduce, withNotice } from '@/lib/hermes-chat/reducer'
import { slashNotice } from '@/lib/hermes-chat/event-notices'
const ctx = { now: () => 1000, id: (() => { let n = 0; return () => `n-${++n}` })() }
const callbacks = { onApproval() {}, onClarify() {}, onSubagentTail() {}, onSubagentSteer() {}, onSubagentInterrupt() {}, onRetry() {} }
it('keeps notices visible between assistant turns, expands full output and cancels pending commands', () => {
  let state = reduce(initialState(), { type: 'message.delta', payload: { text: 'Before' } }, ctx)
  state = withNotice(state, slashNotice('/compress', 'Waiting for reply', 'pending'), ctx)
  const cancel = vi.fn()
  const view = render(<NativeTranscript state={state} callbacks={{ ...callbacks, onCancelNotice: cancel }} />)
  expect(screen.getByText('Before')).toBeTruthy()
  expect(screen.getByText('Queued /compress: Waiting for reply')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel queued command' }))
  expect(cancel).toHaveBeenCalledOnce()
  state = withNotice(state, slashNotice('/compress', 'Full output\nSecond line'), ctx)
  view.rerender(<NativeTranscript state={state} callbacks={callbacks} />)
  expect(screen.queryByRole('button', { name: 'Cancel queued command' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Ran \/compress/ }))
  expect(view.container.querySelector('pre')?.textContent).toBe('Full output\nSecond line')
  state = withNotice(state, slashNotice('/undo', 'Synthetic failure', 'error'), ctx)
  view.rerender(<NativeTranscript state={state} callbacks={callbacks} />)
  expect(screen.getByRole('alert').textContent).toContain('Failed /undo')
})
