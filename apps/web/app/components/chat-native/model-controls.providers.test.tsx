// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeHermesChat } from '@/lib/hermes-chat/use-native-chat'
import { NativeModelControls } from './model-controls'

vi.mock('../chat-model-selector', () => ({ ProviderIcon: () => null }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('offers only Anthropic, OpenAI and OpenCode routes, including during model search', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const setModel = vi.fn().mockResolvedValue({})
  const options = {
    model: 'Claude Test', provider: 'anthropic',
    providers: [
      { slug: 'anthropic', name: 'Anthropic', models: ['Claude Test'] },
      { slug: 'openai-codex', name: 'OpenAI', models: ['GPT Test'] },
      { slug: 'opencode-go', name: 'OpenCode', models: ['OpenCode Test'] },
      { slug: 'nous', name: 'Nous Portal', models: ['Claude Portal Test'] },
      { slug: 'openrouter', name: 'OpenRouter', models: ['Other Test'] },
    ],
  }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(options)))
  const chat = { connection: 'connected', state: { busy: false }, setModel, setReasoning: vi.fn(), setFast: vi.fn() } as unknown as NativeHermesChat
  render(<NativeModelControls conversationKey="synthetic-key" chat={chat} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  const list = await screen.findByRole('listbox', { name: 'Models' })
  expect(within(list).getByRole('button', { name: /Anthropic/ })).toBeInTheDocument()
  expect(within(list).getByRole('button', { name: /OpenAI/ })).toBeInTheDocument()
  expect(within(list).getByRole('button', { name: /OpenCode/ })).toBeInTheDocument()
  expect(within(list).queryAllByRole('button', { name: /Nous Portal|OpenRouter/ })).toHaveLength(0)
  fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'Portal' } })
  expect(within(list).queryByRole('option')).toBeNull()
  expect(within(list).getByText('No models match')).toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'Search models' }), { target: { value: 'OpenCode Test' } })
  fireEvent.click(within(list).getByRole('option', { name: 'OpenCode Test' }))
  await waitFor(() => expect(setModel).toHaveBeenCalledWith('OpenCode Test', 'opencode-go', false))
})
