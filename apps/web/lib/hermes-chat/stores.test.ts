import { describe, expect, it } from 'vitest'
import { buildSubagentTree, initialSubagents, pruneFinishedSubagents, reduceSubagents, type SubagentState } from './subagents'
import { applyTodos, expireTodos, initialTodos, latestSessionTodoSnapshot, mergeTodoItems, parseTodos, settleTodos, todoTree } from './todos'
import { initialState, reduce } from './reducer'

describe('subagent lifecycle', () => {
  it('is queued before start, preserves metrics, and never resurrects terminal/retired identities', () => {
    let state = initialSubagents()
    const payload = { subagent_id: 'child', parent_id: 'parent', child_session_id: 'stored', delegation_id: 'batch', goal: 'work', depth: 2 }
    state = reduceSubagents(state, 'subagent.spawn_requested', payload, 100)
    expect(state.items[0]).toMatchObject({ id: 'child', status: 'queued', depth: 2 })
    state = reduceSubagents(state, 'subagent.start', { ...payload, model: 'm' }, 200)
    state = reduceSubagents(state, 'subagent.spawn_requested', payload, 250)
    expect(state.items[0].status).toBe('running')
    state = reduceSubagents(state, 'subagent.complete', { ...payload, status: 'timeout', duration_seconds: 60, input_tokens: 10, output_tokens: 5, tool_count: 4, files_read: ['a'], files_written: ['b'], output_tail: [{ tool: 'read_file', preview: 'a', is_error: false }] }, 300)
    expect(state.items[0]).toMatchObject({ status: 'failed', model: 'm', inputTokens: 10, outputTokens: 5, toolCount: 4, durationSeconds: 60, parentId: 'parent', sessionId: 'stored', filesRead: ['a'], filesWritten: ['b'] })
    const terminal = state
    expect(reduceSubagents(state, 'subagent.start', payload, 400)).toBe(terminal)
    expect(reduceSubagents(state, 'subagent.complete', { ...payload, status: 'completed' }, 500)).toBe(terminal)
    state = pruneFinishedSubagents(state)
    expect(state.items).toEqual([])
    expect(reduceSubagents(state, 'subagent.start', payload, 600)).toBe(state)
  })

  it('ignores unspawned progress, normalises cancellation, and caps adjacent-deduped activity at 24', () => {
    const empty = initialSubagents()
    expect(reduceSubagents(empty, 'subagent.progress', { subagent_id: 'x', text: 'lost' }, 0)).toBe(empty)
    let state = reduceSubagents(empty, 'subagent.start', { subagent_id: 'x', goal: 'task' }, 1)
    for (let i = 0; i < 30; i++) {
      state = reduceSubagents(state, 'subagent.thinking', { subagent_id: 'x', text: `step ${i}` }, i + 2)
      state = reduceSubagents(state, 'subagent.thinking', { subagent_id: 'x', text: `step ${i}` }, i + 2)
    }
    expect(state.items[0].activity).toHaveLength(24)
    expect(state.items[0].activity[0].text).toBe('step 6')
    state = reduceSubagents(state, 'subagent.complete', { subagent_id: 'x', status: 'cancelled' }, 40)
    expect(state.items[0].status).toBe('interrupted')
    expect(state.items[0].currentTool).toBeUndefined()
  })

  it('uses deterministic fallback ids and a cycle-safe parent tree', () => {
    let state: SubagentState = initialSubagents()
    state = reduceSubagents(state, 'subagent.start', { parent_id: 'p', goal: 'same', task_index: 1 }, 1)
    state = reduceSubagents(state, 'subagent.progress', { parent_id: 'p', goal: 'same', task_index: 1, text: 'progress' }, 2)
    expect(state.items).toHaveLength(1)
    const base = state.items[0]
    const tree = buildSubagentTree([{ ...base, id: 'p', parentId: null }, { ...base, id: 'child', parentId: 'p' }])
    expect(tree[0].children[0].id).toBe('child')
    expect(buildSubagentTree([{ ...base, id: 'a', parentId: 'b' }, { ...base, id: 'b', parentId: 'a' }])).toHaveLength(2)
  })

  it('accepts child terminal completion after parent interruption but not live progress', () => {
    let n = 0
    const ctx = { now: () => 1000, id: () => String(++n) }
    let state = initialState('s')
    for (const event of [
      { type: 'subagent.start', payload: { subagent_id: 'c', goal: 'work' } },
      { type: 'client.interrupt', payload: {} },
      { type: 'subagent.progress', payload: { subagent_id: 'c', text: 'ignore' } },
      { type: 'subagent.complete', payload: { subagent_id: 'c', status: 'completed', summary: 'done' } }
    ]) state = reduce(state, event, ctx)
    expect(state.subagents.items[0]).toMatchObject({ status: 'completed', activity: [{ text: 'done', kind: 'summary' }] })
  })
})

describe('todo snapshots', () => {
  const active = [{ id: '1', content: 'one', status: 'pending' }]
  const finished = [{ id: '1', content: 'one', status: 'completed' }]
  it('rejects lower revision, accepts equal revision, and preserves watermarks/retained data on optimistic writes', () => {
    let state = applyTodos(initialTodos(), { todos: active, revision: 5 }, 0)
    expect(applyTodos(state, { todos: [], revision: 4 }, 1)).toBe(state)
    state = applyTodos(state, { todos: finished, revision: 5 }, 2)
    expect(state.visible[0].status).toBe('completed')
    expect(state.expiresAt).toBe(4002)
    state = applyTodos(state, { args: { merge: true, todos: [{ id: '1', status: 'in_progress' }, { id: '2', content: 'two', status: 'pending' }] } }, 3, true)
    expect(state.revision).toBe(5)
    expect(state.retained[0].status).toBe('completed')
    expect(state.visible.map(t => [t.content, t.status])).toEqual([['one', 'in_progress'], ['two', 'pending']])
    const settled = settleTodos(state)
    expect(settled.visible).toEqual([])
    expect(settled.retained).toEqual(state.retained)
    expect(settled.revision).toBe(5)
  })

  it('expires finished display after four seconds without forgetting durable snapshot and replaces with authoritative empty snapshots', () => {
    const state = applyTodos(initialTodos(), { todos: finished, revision: 2 }, 100)
    expect(expireTodos(state, 4099)).toBe(state)
    const expired = expireTodos(state, 4100)
    expect(expired.visible).toEqual([])
    expect(expired.retained).toEqual(finished)
    expect(settleTodos(state)).toBe(state)
    expect(applyTodos(expired, { todos: [], revision: 3 }, 4200)).toMatchObject({ visible: [], retained: [], revision: 3 })
  })

  it('keeps parser/merge/tree and confirmed durable-result selection semantics', () => {
    expect(parseTodos(JSON.stringify({ todos: active }))).toEqual(active)
    expect(mergeTodoItems(parseTodos(active)!, [{ id: '1', status: 'completed' }])[0].content).toBe('one')
    const list = parseTodos([...active, { id: '2', content: 'nested', status: 'pending', parent: '1' }])!
    expect(todoTree(list).map(([item, depth]) => [item.id, depth])).toEqual([['1', 0], ['2', 1]])
    expect(latestSessionTodoSnapshot([{ parts: [{ type: 'tool-call', toolName: 'todo_list', args: { todos: active }, result: { todos: finished, revision: 6 } }] }])).toEqual({ todos: finished, revision: 6 })
    expect(latestSessionTodoSnapshot([{ parts: [{ type: 'tool-call', toolName: 'todo_list', args: { todos: active, revision: 9 }, unpairedStoredToolResult: true }] }])).toBeNull()
  })

  it('clears active todo display on parent completion while retaining revisions', () => {
    const ctx = { now: () => 1000, id: () => 'id' }
    let state = reduce(initialState(), { type: 'todo.updated', payload: { todos: active, revision: 9 } }, ctx)
    state = reduce(state, { type: 'message.complete', payload: {} }, ctx)
    expect(state.todos).toMatchObject({ visible: [], retained: active, revision: 9 })
  })
})
