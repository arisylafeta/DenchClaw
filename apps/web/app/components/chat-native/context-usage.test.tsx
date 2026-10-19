// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContextUsage } from './context-usage'
import { contextWindowUsage, formatContextTokens } from '@/lib/hermes-chat/context-usage'

afterEach(cleanup)
it('formats compact token counts without redundant decimals', () => {
  expect([0, 999, 1000, 42100, 200000, 1000000].map(formatContextTokens)).toEqual(['0', '999', '1k', '42.1k', '200k', '1000k'])
})
it('hides absent or invalid occupancy, never substitutes cumulative billed tokens', () => {
  for (const usage of [null, {}, { input: 100, output: 20, total: 120 }, { context_used: 10 }, { context_used: 10, context_max: 0 }, { context_used: -1, context_max: 200 }, { context_used: NaN, context_max: 200 }, { context_used: 10, context_max: Infinity }]) {
    expect(contextWindowUsage(usage)).toBeNull()
    const { container, unmount } = render(<ContextUsage usage={usage} />)
    expect(container.innerHTML).toBe('')
    unmount()
  }
})
it('shows occupancy, a percentage tooltip and an estimated label', () => {
  render(<ContextUsage usage={{ context_used: 42100, context_max: 200000, context_estimated: true }} />)
  expect(screen.getByText('42.1k / 200k')).toBeInTheDocument()
  expect(screen.getByTitle('Estimated context: 42,100 / 200,000 tokens (21.1%)')).toHaveAttribute('tabindex', '0')
})
it('keeps zero visible and caps the bar without hiding overflow usage', () => {
  const { rerender, container } = render(<ContextUsage usage={{ context_used: 0, context_max: 200000 }} />)
  expect(screen.getByText('0 / 200k')).toBeInTheDocument()
  rerender(<ContextUsage usage={{ context_used: 220000, context_max: 200000 }} />)
  expect(screen.getByTitle('Context: 220,000 / 200,000 tokens (110.0%)')).toBeInTheDocument()
  expect(container.querySelector('[style]')).toHaveStyle({ width: '100%' })
})
