import { describe, expect, it } from 'vitest'
import { initialState, messageText, reduce, selectTools } from './reducer'
import type { GatewayEvent } from './events'

function replay(events: GatewayEvent[]) {
  let id = 0
  const ctx = { now: () => 1000, id: () => String(++id) }
  return events.reduce((state, event) => reduce(state, event, ctx), initialState())
}

describe('terminal and contextual boundaries', () => {
  it('matches overlapping id-less calls by identifying args when context is omitted', () => {
    const state = replay([
      { type: 'message.start', payload: {} },
      { type: 'tool.start', payload: { name: 'read_file', args: { path: 'a' } } },
      { type: 'tool.start', payload: { name: 'read_file', args: { path: 'b' } } },
      { type: 'tool.complete', payload: { name: 'read_file', args: { path: 'b' }, result: 'B' } },
      { type: 'tool.complete', payload: { name: 'read_file', args: { path: 'a' }, result: 'A' } }
    ])
    expect(selectTools(state).map(tool => [tool.args.path, tool.result])).toEqual([['a', 'A'], ['b', 'B']])
  })

  it('keeps retained whole-buffer partial text on both sides of tool boundaries', () => {
    const state = replay([
      { type: 'message.start', payload: {} },
      { type: 'message.delta', payload: { text: 'Before ' } },
      { type: 'tool.start', payload: { name: 'terminal', tool_id: 't' } },
      { type: 'message.delta', payload: { text: 'After' } },
      { type: 'message.complete', payload: { text: 'Before After partial', status: 'error', error: 'limit', partial: true } }
    ])
    expect(state.messages[0].segments.map(segment => segment.type === 'tool' ? segment.name : segment.text)).toEqual(['Before ', 'terminal', 'After partial'])
    expect(messageText(state.messages[0])).toBe('Before After partial')
    expect(selectTools(state)[0].status).toBe('done')
  })

  it('patches a duplicate late completion without making a new bubble or reopening the settled run', () => {
    const state = replay([
      { type: 'message.start', payload: {} },
      { type: 'tool.start', payload: { name: 'terminal', tool_id: 't' } },
      { type: 'tool.complete', payload: { name: 'terminal', tool_id: 't', result: 'ok' } },
      { type: 'message.complete', payload: { text: 'done' } },
      { type: 'tool.complete', payload: { name: 'terminal', tool_id: 't', result: 'ok', duration_s: 2 } }
    ])
    expect(state.messages).toHaveLength(1)
    expect(selectTools(state)).toHaveLength(1)
    expect(selectTools(state)[0].duration_s).toBe(2)
    expect(state).toMatchObject({ busy: false, live: false, streamId: null })
  })

  it('sets interruption from the terminal status without a local Stop action', () => {
    const state = replay([
      { type: 'message.start', payload: {} },
      { type: 'message.delta', payload: { text: 'partial' } },
      { type: 'message.complete', payload: { text: 'partial', status: 'interrupted' } }
    ])
    expect(state).toMatchObject({ interrupted: true, live: false, busy: false })
    expect(state.messages[0]).toMatchObject({ interrupted: true, status: 'interrupted' })
  })
})
