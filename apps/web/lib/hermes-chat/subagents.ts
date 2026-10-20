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

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
export interface SubagentActivity { at: number; kind: 'progress' | 'thinking' | 'tool' | 'summary'; text: string; isError?: boolean }
export interface SubagentOutput { tool: string; preview: string; is_error: boolean }
export interface Subagent {
  id: string
  parentId: string | null
  sessionId?: string
  delegationId?: string
  depth: number
  goal: string
  taskIndex: number
  taskCount: number
  status: SubagentStatus
  startedAt: number
  updatedAt: number
  model?: string
  /** Hermes profile running this child, when the gateway reports one; otherwise it inherits the parent's. */
  profile?: string
  durationSeconds?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  toolCount?: number
  filesRead: string[]
  filesWritten: string[]
  outputTail: SubagentOutput[]
  activity: SubagentActivity[]
  currentTool?: string
  summary?: string
}
export interface SubagentState { items: Subagent[]; retiredIds: string[] }
export interface SubagentNode extends Subagent { children: SubagentNode[] }
export const initialSubagents = (): SubagentState => ({ items: [], retiredIds: [] })
export const isTerminalSubagent = (status: SubagentStatus): boolean => !['queued', 'running'].includes(status)
export function normalizeSubagentStatus(status: unknown, terminal = false): SubagentStatus {
  if (status === 'completed' || status === 'failed' || status === 'interrupted') return status
  if (status === 'cancelled' || status === 'canceled') return 'interrupted'
  if (terminal || status === 'timeout' || status === 'error') return 'failed'
  return status === 'queued' ? 'queued' : 'running'
}
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const strings = (value: unknown, fallback: string[] = []): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : fallback
export function reduceSubagents(state: SubagentState, type: string, payload: unknown, now: number): SubagentState {
  const p = asRecord(payload)
  const id = stringValue(p.subagent_id) || `${stringValue(p.parent_id) || 'root'}:${num(p.task_index) ?? 0}:${stringValue(p.goal)}`
  const prev = state.items.find(item => item.id === id)
  if (state.retiredIds.includes(id) || (prev && isTerminalSubagent(prev.status))) return state
  const status = normalizeSubagentStatus(p.status ?? (type === 'subagent.spawn_requested' ? 'queued' : 'running'), type === 'subagent.complete')
  // An out-of-order spawn acknowledgement cannot demote a running child.
  const nextStatus = prev?.status === 'running' && status === 'queued' ? 'running' : status
  let activity = prev?.activity ?? []
  const append = (kind: SubagentActivity['kind'], text: string, isError = false) => {
    text = text.replace(/\s+/g, ' ').trim()
    const last = activity.at(-1)
    if (text && !(last?.kind === kind && last.text === text && Boolean(last.isError) === isError)) {
      activity = [...activity, { at: now, kind, text, isError }].slice(-24)
    }
  }
  const outputTail: SubagentOutput[] = Array.isArray(p.output_tail) ? p.output_tail.map(value => {
    const row = asRecord(value)
    return { tool: stringValue(row.tool), preview: stringValue(row.preview), is_error: row.is_error === true }
  }) : prev?.outputTail ?? []
  if (Array.isArray(p.output_tail)) for (const row of outputTail) append(row.tool ? 'tool' : 'progress', [row.tool, row.preview].filter(Boolean).join(': '), row.is_error)
  const tool = stringValue(p.tool_name)
  if (tool) append('tool', [tool, stringValue(p.tool_preview) || stringValue(p.text)].filter(Boolean).join(': '))
  if (type === 'subagent.progress' || type === 'subagent.thinking') append(type === 'subagent.thinking' ? 'thinking' : 'progress', stringValue(p.text))
  const summary = stringValue(p.summary) || (p.status === 'timeout' ? `Timed out after ${num(p.duration_seconds) ?? '?'}s` : '') || prev?.summary
  if (isTerminalSubagent(nextStatus)) append('summary', summary || stringValue(p.text), nextStatus === 'failed')
  const next: Subagent = {
    id, parentId: stringValue(p.parent_id) || prev?.parentId || null,
    sessionId: stringValue(p.child_session_id) || prev?.sessionId,
    delegationId: stringValue(p.delegation_id) || prev?.delegationId,
    depth: num(p.depth) ?? prev?.depth ?? 0,
    goal: stringValue(p.goal) || prev?.goal || '',
    taskIndex: num(p.task_index) ?? prev?.taskIndex ?? 0,
    taskCount: num(p.task_count) ?? prev?.taskCount ?? 1,
    status: nextStatus, startedAt: prev?.startedAt ?? now, updatedAt: now,
    model: stringValue(p.model) || prev?.model,
    profile: stringValue(p.profile) || prev?.profile,
    durationSeconds: num(p.duration_seconds) ?? prev?.durationSeconds,
    inputTokens: num(p.input_tokens) ?? prev?.inputTokens,
    outputTokens: num(p.output_tokens) ?? prev?.outputTokens,
    reasoningTokens: num(p.reasoning_tokens) ?? prev?.reasoningTokens,
    toolCount: num(p.tool_count) ?? prev?.toolCount,
    filesRead: strings(p.files_read, prev?.filesRead), filesWritten: strings(p.files_written, prev?.filesWritten),
    outputTail, activity, summary,
    currentTool: isTerminalSubagent(nextStatus) ? undefined : tool || prev?.currentTool
  }
  return { ...state, items: prev ? state.items.map(item => item.id === id ? next : item) : [...state.items, next] }
}
export function pruneFinishedSubagents(state: SubagentState): SubagentState {
  return {
    items: state.items.filter(item => !isTerminalSubagent(item.status)),
    retiredIds: [...new Set([...state.retiredIds, ...state.items.filter(item => isTerminalSubagent(item.status)).map(item => item.id)])]
  }
}
/** Cyclic/missing parents become roots rather than losing rows or recursing forever. */
export function buildSubagentTree(items: readonly Subagent[]): SubagentNode[] {
  const nodes = new Map(items.map(item => [item.id, { ...item, children: [] } as SubagentNode]))
  const roots: SubagentNode[] = []
  for (const node of nodes.values()) {
    let cursor = node.parentId
    const seen = new Set([node.id])
    while (cursor && !seen.has(cursor)) { seen.add(cursor); cursor = nodes.get(cursor)?.parentId ?? null }
    const parent = cursor ? undefined : node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (list: SubagentNode[]) => {
    list.sort((a, b) => a.startedAt - b.startedAt || a.taskIndex - b.taskIndex)
    for (const node of list) sort(node.children)
  }
  sort(roots)
  return roots
}
export const activeSubagentCount = (items: readonly Subagent[]): number => items.filter(item => !isTerminalSubagent(item.status)).length
