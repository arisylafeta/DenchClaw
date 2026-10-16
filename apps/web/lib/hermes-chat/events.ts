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
// Local structural subset of apps/shared/src/gateway-contract.generated.ts and
// tui_gateway/contracts/events.py in /usr/local/lib/hermes-agent. No vendor dependency.
export interface Usage {
  model?: string
  input?: number
  output?: number
  reasoning?: number
  prompt?: number
  completion?: number
  total?: number
  calls?: number
  context_used?: number | null
  context_max?: number | null
  context_percent?: number | null
  cost_usd?: number | null
  [key: string]: unknown
}
export interface ErrorSurface {
  layer: string
  code: string
  retryable: boolean
  resets_at?: number | null
  provider?: string | null
  model?: string | null
  [key: string]: unknown
}
export interface PersistedTurn {
  row_ids: number[]
  complete: boolean
  user_row_id?: number | null
  final_assistant_row_id?: number | null
}
export interface ClarifyQuestion {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}
export interface EventPayload {
  text?: unknown
  name?: string
  tool_id?: string | null
  tool_call_id?: string | null
  id?: string
  context?: string | null
  args?: unknown
  arguments?: unknown
  result?: unknown
  result_text?: string | null
  summary?: string | null
  message?: string
  preview?: string | null
  inline_diff?: string | null
  duration_s?: number | null
  error?: string | boolean | null
  status?: string | null
  partial?: boolean | null
  response_previewed?: boolean | null
  response_transformed?: boolean | null
  response_reused?: boolean | null
  persisted_turn?: PersistedTurn | null
  error_surface?: ErrorSurface | null
  usage?: Usage | null
  running?: boolean
  stored_session_id?: string
  request_id?: string
  questions?: ClarifyQuestion[]
  question?: string
  command?: string
  description?: string
  choices?: string[]
  allow_permanent?: boolean | null
  allow_session?: boolean | null
  answers?: Record<string, string | null> | null
  todos?: unknown
  revision?: number | null
  already_streamed?: boolean
  rendered?: string | null
  verbose?: boolean | null
  subagent_id?: string | null
  parent_id?: string | null
  child_session_id?: string | null
  delegation_id?: string | null
  depth?: number | null
  goal?: string
  task_count?: number
  task_index?: number
  model?: string | null
  tool_count?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
  reasoning_tokens?: number | null
  files_read?: string[] | null
  files_written?: string[] | null
  output_tail?: { tool: string; preview: string; is_error: boolean }[] | null
  tool_name?: string | null
  tool_preview?: string | null
  duration_seconds?: number | null
}
export interface GatewayEvent {
  type: string
  session_id?: string | null
  seq?: number
  payload: EventPayload
  /** CRM transport epoch, not a Hermes envelope member. */
  generation?: string | number
  replayed?: boolean
  /** JSON-RPC srq-* id, distinct from approval payload.request_id. */
  requestId?: string | number
}
export const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try { return asRecord(JSON.parse(value)) } catch { return {} }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export const stringValue = (value: unknown): string => typeof value === 'string' ? value : ''
