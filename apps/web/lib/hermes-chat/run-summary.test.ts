import { describe, expect, it } from 'vitest'
import { groupToolRuns, parseUnifiedDiff, summarizeToolRun } from './run-summary'
import type { ToolSegment } from './reducer'
const tool = (id: string, name: string, args: Record<string, unknown> = {}, status: ToolSegment['status'] = 'done'): ToolSegment => ({ type: 'tool', id, toolId: id, name, args, status, startedAt: 0 })

describe('tool run model', () => {
  it('groups only consecutive tools and never mutates source segments', () => {
    const segments = [tool('a', 'read_file'), tool('b', 'terminal'), { type: 'text' as const, id: 'text', text: 'explanation', startedAt: 1 }, tool('c', 'edit_file')]
    const grouped = groupToolRuns(segments)
    expect(grouped.map(p => p.type)).toEqual(['tool-run', 'text', 'tool-run'])
    expect(grouped[0]).toMatchObject({ tools: [{ id: 'a' }, { id: 'b' }] })
    expect(segments).toHaveLength(4)
  })
  it('returns category counts, targets, failures and the newest running present-tense key', () => {
    const tools = [tool('a', 'read_file', { path: '/x' }), tool('b', 'web_search', { query: 'batteries' }), tool('c', 'terminal', { command: 'git status' }, 'running'), tool('d', 'edit_file', { path: '/y' }, 'running'), tool('e', 'web_extract', { urls: ['https://a', 'https://b'] }), tool('f', 'delegate_task'), tool('g', 'terminal', {}, 'error')]
    const summary = summarizeToolRun(tools, true)
    expect(summary.clauses.map(c => [c.category, c.count])).toEqual([['edit', 1], ['explore', 1], ['search', 1], ['run', 2], ['fetch', 2], ['delegate', 1]])
    expect(summary.live).toEqual({ category: 'edit', tense: 'present', toolId: 'd', name: 'edit_file', target: '/y' })
    expect(summary.failed).toBe(1)
    expect(summary.clauses.find(c => c.category === 'run')!.targets).toEqual(['git status'])
    expect(summarizeToolRun(tools, false).live).toBeNull()
  })
  it('counts multi-file unified diffs without treating headers or plus/minus source as metadata', () => {
    const text = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,2 +1,3 @@', '-old', '+new', ' keep', '+++actual source', 'diff --git a/deleted b/deleted', '--- a/deleted', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone', '\\ No newline at end of file', 'diff --git a/new b/new', '--- /dev/null', '+++ b/new', '@@ -0,0 +1 @@', '+created'].join('\n')
    expect(parseUnifiedDiff(text)).toEqual([{ path: 'a.ts', added: 2, removed: 1 }, { path: 'deleted', added: 0, removed: 1 }, { path: 'new', added: 1, removed: 0 }])
    expect(parseUnifiedDiff('not a diff')).toEqual([])
  })
})
