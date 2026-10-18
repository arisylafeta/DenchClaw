"use client";

import { useState } from "react";
import type { ErrorSurface, Usage } from "@/lib/hermes-chat/events";
import type { SubagentNode } from "@/lib/hermes-chat/subagents";
import { isTerminalSubagent } from "@/lib/hermes-chat/subagents";
import type { TodoItem, TodoState } from "@/lib/hermes-chat/todos";
import type { NativeTranscriptCallbacks } from "./types";
import { buttonClass, cardClass, Elapsed } from "./tool-run";

export interface SubagentCardProps {
  agent: SubagentNode;
  callbacks: Pick<NativeTranscriptCallbacks, "onSubagentTail" | "onSubagentSteer" | "onSubagentInterrupt">;
  tailText?: string;
  tails?: Readonly<Record<string, string>>;
}
export function SubagentCard({ agent, callbacks, tailText, tails }: SubagentCardProps) {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const terminal = isTerminalSubagent(agent.status);
  const act = async (action: () => void | Promise<void>, success: string) => {
    setSending(true);
    try { await action(); setFeedback(success); } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "Action failed"); } finally { setSending(false); }
  };
  return <section className={cardClass} aria-label={`Subagent: ${agent.goal}`} data-subagent-id={agent.id}>
    <h3>{agent.goal}</h3><p><span>{agent.status}</span>{agent.model && ` · ${agent.model}`} · <Elapsed startedAt={agent.startedAt} completedAt={terminal ? agent.updatedAt : undefined} seconds={terminal ? agent.durationSeconds : undefined} /></p>
    <p>{agent.toolCount ?? 0} tools · {agent.inputTokens ?? 0} tokens in / {agent.outputTokens ?? 0} out{agent.reasoningTokens !== undefined && ` / ${agent.reasoningTokens} reasoning`} · {agent.filesRead.length} files read / {agent.filesWritten.length} written</p>
    {(agent.filesRead.length > 0 || agent.filesWritten.length > 0) && <details><summary>Files</summary><ul>{agent.filesRead.map(file => <li key={`read-${file}`}>Read: {file}</li>)}{agent.filesWritten.map(file => <li key={`write-${file}`}>Written: {file}</li>)}</ul></details>}
    {agent.summary && <p>{agent.summary}</p>}
    {agent.outputTail.length > 0 && <pre className="max-h-60 overflow-auto whitespace-pre-wrap">{agent.outputTail.map(row => `${row.is_error ? "Error · " : ""}${row.tool}: ${row.preview}`).join("\n")}</pre>}
    <button type="button" className={buttonClass} disabled={sending} onClick={() => void act(() => callbacks.onSubagentTail(agent.id), "Tail requested")}>Open tail</button>
    {(tailText ?? tails?.[agent.id]) !== undefined && <pre aria-label="Subagent tail" className="max-h-72 overflow-auto whitespace-pre-wrap">{tailText ?? tails?.[agent.id]}</pre>}
    <ol aria-label="Recent activity">{agent.activity.slice(expanded ? -24 : -5).map((activity, index) => <li key={`${activity.at}-${index}`}>{activity.kind}: {activity.text}</li>)}</ol>
    {agent.activity.length > 5 && <button type="button" className={buttonClass} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show latest 5" : "Show all activity"}</button>}
    <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (!terminal && text.trim()) void act(() => callbacks.onSubagentSteer(agent.id, text.trim()), "Steer queued (not yet delivered)"); }}>
      <label>Steer subagent<input className="block rounded border border-[var(--color-border)] bg-transparent p-2" disabled={terminal || sending} value={text} onChange={event => setText(event.target.value)} /></label>
      <button className={buttonClass} type="submit" disabled={terminal || sending || !text.trim()}>Queue steer</button>
      <button className={buttonClass} type="button" disabled={terminal || sending} onClick={() => void act(() => callbacks.onSubagentInterrupt(agent.id), "Interrupt requested")}>Interrupt</button>
    </form>
    <p role="status">{feedback}</p>
    {agent.children.length > 0 && <div className="ml-4 space-y-2" aria-label="Child subagents">{agent.children.map(child => <SubagentCard key={child.id} agent={child} callbacks={callbacks} tails={tails} />)}</div>}
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
