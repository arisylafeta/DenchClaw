/**
 * Ported from Hermes Desktop / shared gateway contracts.
 * Copyright (c) 2025 Nous Research. MIT License.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { asRecord, stringValue } from './events'
import type { Segment, ToolSegment } from './reducer'

export type RunCategory = 'explore' | 'search' | 'run' | 'edit' | 'fetch' | 'delegate' | 'other'
export interface RunClause { category: RunCategory; count: number; targets: string[] }
export interface LiveToolLine { category: RunCategory; tense: 'present'; toolId: string; name: string; target: string }
export interface ToolRunSummary { clauses: RunClause[]; failed: number; live: LiveToolLine | null }
export interface ToolRun { type: 'tool-run'; id: string; tools: ToolSegment[] }
export type RunItem = Exclude<Segment, ToolSegment> | ToolRun
export interface DiffFile { path: string; added: number; removed: number }
export function toolCategory(name: string): RunCategory {
  if (['write_file', 'patch', 'apply_patch', 'edit_file', 'file_edit', 'write', 'edit', 'multi_edit'].includes(name)) return 'edit'
  if (['read_file', 'list_files', 'search_files', 'glob', 'read', 'ls'].includes(name)) return 'explore'
  if (['web_search', 'session_search_recall', 'search', 'grep'].includes(name)) return 'search'
  if (['terminal', 'execute_code', 'bash', 'shell'].includes(name)) return 'run'
  if (['web_extract', 'browser_navigate', 'web_fetch', 'fetch'].includes(name)) return 'fetch'
  return name === 'delegate_task' ? 'delegate' : 'other'
}
export function toolTarget(tool: Pick<ToolSegment, 'name' | 'args'>): string {
  const args = asRecord(tool.args)
  const category = toolCategory(tool.name)
  const keys = category === 'run' ? ['command', 'code'] : category === 'search' ? ['query', 'search_term', 'pattern'] : ['path', 'file', 'filepath', 'file_path', 'url', 'query']
  for (const key of keys) {
    const value = stringValue(args[key]).trim()
    if (value) return value
  }
  if (Array.isArray(args.urls)) return stringValue(args.urls[0])
  return ''
}
export function groupToolRuns(segments: readonly Segment[]): RunItem[] {
  const items: RunItem[] = []
  for (const segment of segments) {
    if (segment.type !== 'tool') { items.push(segment); continue }
    const previous = items.at(-1)
    if (previous?.type === 'tool-run') previous.tools.push(segment)
    else items.push({ type: 'tool-run', id: segment.id, tools: [segment] })
  }
  return items
}
export function summarizeToolRun(tools: readonly ToolSegment[], live: boolean): ToolRunSummary {
  const counts = new Map<RunCategory, RunClause>()
  for (const tool of tools) {
    const category = toolCategory(tool.name)
    const clause = counts.get(category) ?? { category, count: 0, targets: [] }
    const urls = asRecord(tool.args).urls
    clause.count += category === 'fetch' && Array.isArray(urls) && urls.length ? urls.length : 1
    const target = toolTarget(tool)
    if (target && !clause.targets.includes(target)) clause.targets.push(target)
    counts.set(category, clause)
  }
  const newest = live ? tools.findLast(tool => tool.status === 'running') : undefined
  return {
    clauses: (['edit', 'explore', 'search', 'run', 'fetch', 'delegate', 'other'] as const).flatMap(category => counts.has(category) ? [counts.get(category)!] : []),
    failed: tools.filter(tool => tool.status === 'error').length,
    live: newest ? { category: toolCategory(newest.name), tense: 'present', toolId: newest.toolId, name: newest.name, target: toolTarget(newest) } : null
  }
}
/** Parses rendered unified diff text; headers and no-newline markers are not changes. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let inHunk = false
  let oldPath = ''
  let oldRemaining = 0
  let newRemaining = 0
  const pathOf = (path: string): string => {
    path = path.split('\t')[0].trim()
    if (path.startsWith('"')) { try { path = JSON.parse(path) as string } catch { path = path.slice(1, -1) } }
    return path.replace(/^[ab]\//, '')
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) { file = undefined; inHunk = false; continue }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) { oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1); inHunk = true; continue }
    if (!inHunk && line.startsWith('--- ')) { oldPath = pathOf(line.slice(4)); continue }
    if (!inHunk && line.startsWith('+++ ')) {
      const path = pathOf(line.slice(4))
      file = { path: path === '/dev/null' ? oldPath : path, added: 0, removed: 0 }
      files.push(file); continue
    }
    if (!inHunk || !file) continue
    if (line.startsWith('+')) { file.added++; newRemaining-- }
    else if (line.startsWith('-')) { file.removed++; oldRemaining-- }
    else if (line.startsWith(' ')) { oldRemaining--; newRemaining-- }
    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false
  }
  return files
}
