"use client";

import { useState } from "react";
import type { ErrorSurface, Usage } from "@/lib/hermes-chat/events";
import type { SubagentNode } from "@/lib/hermes-chat/subagents";
import { isTerminalSubagent } from "@/lib/hermes-chat/subagents";
import type { TodoItem, TodoState } from "@/lib/hermes-chat/todos";
import type { NativeTranscriptCallbacks } from "./types";
import { Bot } from "lucide-react";
import { buttonClass, cardClass, Elapsed, type StepState, TraceStep } from "./tool-run";

export interface SubagentCardProps {
  agent: SubagentNode;
  callbacks: Pick<NativeTranscriptCallbacks, "onSubagentTail" | "onSubagentSteer" | "onSubagentInterrupt">;
  tailText?: string;
  tails?: Readonly<Record<string, string>>;
}
const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
const actionClass = "rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-2 disabled:opacity-40";
/** A running or finished subagent, shown as a step in the same trace as tool calls. */
export function SubagentCard({ agent, callbacks, tailText, tails, connectPrevious, connectNext }: SubagentCardProps & { connectPrevious?: boolean; connectNext?: boolean }) {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [steering, setSteering] = useState(false);
  const [sending, setSending] = useState(false);
  const terminal = isTerminalSubagent(agent.status);
  const state: StepState = agent.status === "failed" || agent.status === "interrupted" ? "error" : terminal ? "done" : "running";
  const act = async (action: () => void | Promise<void>, success: string) => {
    setSending(true);
    try { await action(); setFeedback(success); } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "Action failed"); } finally { setSending(false); }
  };
  const tail = tailText ?? tails?.[agent.id];
  const latest = terminal ? agent.summary : agent.activity.at(-1)?.text;
  const stats = [agent.toolCount ? `${agent.toolCount} ${agent.toolCount === 1 ? "tool" : "tools"}` : "", agent.filesRead.length ? `${agent.filesRead.length} read` : "", agent.filesWritten.length ? `${agent.filesWritten.length} written` : "", agent.inputTokens || agent.outputTokens ? `${compact((agent.inputTokens ?? 0) + (agent.outputTokens ?? 0))} tokens` : "", agent.model ?? ""].filter(Boolean).join(" · ");
  const status = state === "running" ? "Running" : agent.status === "failed" ? "Failed" : agent.status === "interrupted" ? "Stopped" : "Done";
  return <section aria-label={`Subagent: ${agent.goal}`} data-subagent-id={agent.id} className="w-full min-w-0">
    <TraceStep state={state} icon={Bot} label={`Subagent · ${agent.goal.length > 80 ? `${agent.goal.slice(0, 79)}…` : agent.goal}`} connectPrevious={connectPrevious} connectNext={connectNext}
      detail={<>{status} · <Elapsed startedAt={agent.startedAt} completedAt={terminal ? agent.updatedAt : undefined} seconds={terminal ? agent.durationSeconds : undefined} /></>}>
      {stats && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{stats}</p>}
      {latest && <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-[var(--color-text-muted)]">{state === "running" ? "Now: " : ""}{latest}</p>}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <button type="button" className={actionClass} disabled={sending} onClick={() => void act(() => callbacks.onSubagentTail(agent.id), "")}>View output</button>
        {!terminal && <button type="button" className={actionClass} disabled={sending} aria-expanded={steering} onClick={() => setSteering(!steering)}>Steer</button>}
        {!terminal && <button type="button" className={actionClass} disabled={sending} onClick={() => void act(() => callbacks.onSubagentInterrupt(agent.id), "Stop requested")}>Stop</button>}
      </div>
      {steering && !terminal && <form className="mt-1 flex items-center gap-1" onSubmit={event => { event.preventDefault(); if (text.trim()) void act(async () => { await callbacks.onSubagentSteer(agent.id, text.trim()); setText(""); setSteering(false); }, "Steer queued, not yet delivered"); }}>
        <input aria-label="Steer subagent" autoFocus className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-transparent px-2 py-0.5 text-[11px]" disabled={sending} value={text} onChange={event => setText(event.target.value)} placeholder="Tell it what to do differently" />
        <button className={actionClass} type="submit" disabled={sending || !text.trim()}>Send</button>
      </form>}
      {tail !== undefined && <pre aria-label="Subagent tail" className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-surface-hover)] p-2 font-mono text-[11px] leading-5">{tail}</pre>}
      <p role="status" className="text-[11px] text-[var(--color-text-muted)]">{feedback}</p>
    </TraceStep>
    {agent.children.length > 0 && <div className="ml-7 w-[calc(100%-1.75rem)]" aria-label="Child subagents">{agent.children.map((child, index) => <SubagentCard key={child.id} agent={child} callbacks={callbacks} tails={tails} connectPrevious={index > 0} connectNext={index < agent.children.length - 1} />)}</div>}
  </section>;
}
export interface TodoPanelProps { todos: TodoState }
export function TodoPanel({ todos }: TodoPanelProps) {
  const items = todos.visible.length ? todos.visible : todos.retained;
  if (!items.length) return null;
  // Missing or cyclic parents remain visible as roots, never disappear or recurse forever.
  const roots = items.filter(item => {
    let parent = item.parent;
    const seen = new Set([item.id]);
    while (parent) { if (seen.has(parent)) return true; seen.add(parent); const node = items.find(candidate => candidate.id === parent); if (!node) return true; parent = node.parent; }
    return !item.parent;
  });
  const renderItems = (rows: TodoItem[], ancestors: string[]) => <ul className="ml-4 space-y-1">{rows.filter(item => !ancestors.includes(item.id)).map(item => <li key={item.id} data-todo-id={item.id}><span>{item.content} · {item.status.replace("_", " ")}</span>{renderItems(items.filter(child => child.parent === item.id), [...ancestors, item.id])}</li>)}</ul>;
  return <section aria-label="Tasks" className={cardClass}><h3>Tasks · {items.filter(item => item.status === "completed").length}/{items.length} done</h3>{renderItems(roots, [])}</section>;
}
export interface UsageMeterProps { usage: Usage | null }
export function UsageMeter({ usage }: UsageMeterProps) {
  if (!usage) return null;
  const percent = usage.context_percent ?? (usage.context_used != null && usage.context_max ? usage.context_used / usage.context_max * 100 : null);
  return <section aria-label="Usage" className="flex flex-wrap gap-3 text-sm text-[var(--color-text-muted)]">
    <span>{usage.input ?? usage.prompt ?? 0} tokens in / {usage.output ?? usage.completion ?? 0} out</span>
    {percent != null && <label>Context {percent.toFixed(1)}% <meter min={0} max={100} value={percent} aria-label="Context usage" /></label>}
    {usage.cost_usd != null && <span>${usage.cost_usd.toFixed(4)}</span>}
  </section>;
}
export interface ErrorCardProps { error: ErrorSurface; message?: string; partial?: boolean; onRetry: NativeTranscriptCallbacks["onRetry"] }
export function ErrorCard({ error, message, partial, onRetry }: ErrorCardProps) {
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState("");
  return <section role="alert" className={cardClass}>
    <h3>{message || "An error occurred"}</h3><p>{error.layer} · {error.code} · {error.retryable ? "Retryable" : "Not retryable"}</p>
    {partial && <p>Partial response retained</p>}{error.resets_at != null && <p>Resets at {new Date(error.resets_at < 1e12 ? error.resets_at * 1000 : error.resets_at).toLocaleString()}</p>}
    {error.retryable && <button type="button" className={buttonClass} disabled={retrying} onClick={async () => { setRetrying(true); try { await onRetry(); } catch (cause) { setFailure(cause instanceof Error ? cause.message : "Retry failed"); } finally { setRetrying(false); } }}>Retry</button>}{failure && <p>{failure}</p>}
  </section>;
}
export interface ReadOnlyNoticeProps { source: string; onBranch(): void | Promise<void> }
export function ReadOnlyNotice({ source, onBranch }: ReadOnlyNoticeProps) {
  const [branching, setBranching] = useState(false);
  const [error, setError] = useState("");
  return <aside className={cardClass} aria-label="Read-only conversation"><p>This {source} conversation is read-only. Continue in a new chat to send messages. The branch copies visible messages, not the tool transcript.</p><button type="button" className={buttonClass} disabled={branching} onClick={async () => { setBranching(true); try { await onBranch(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create chat"); } finally { setBranching(false); } }}>Continue as new chat</button>{error && <p role="alert">{error}</p>}</aside>;
}
