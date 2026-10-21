"use client";

import { useState } from "react";
import type { ErrorSurface, Usage } from "@/lib/hermes-chat/events";
import type { SubagentNode } from "@/lib/hermes-chat/subagents";
import { isTerminalSubagent } from "@/lib/hermes-chat/subagents";
import type { NativeTranscriptCallbacks } from "./types";
import { Check, ChevronRight, CircleAlert } from "lucide-react";
import { ProfileAvatar } from "../workspace/profile-avatar";
import { buttonClass, cardClass, chipClass, Elapsed } from "./tool-run";
import { describeError } from "@/lib/hermes-chat/error-copy";

export interface SubagentCardProps {
  agent: SubagentNode;
  callbacks: Pick<NativeTranscriptCallbacks, "onSubagentTail" | "onSubagentSteer" | "onSubagentInterrupt">;
  tailText?: string;
  tails?: Readonly<Record<string, string>>;
  /** The parent chat's profile; subagents without their own profile inherit it. */
  profile?: string | null;
}
const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
const actionClass = "rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)] focus-visible:outline-2 disabled:opacity-40";
/** One subagent: a single line (goal, status, time) that opens into stats, latest activity and controls. No per-agent trace. */
export function SubagentCard({ agent, callbacks, tailText, tails, profile }: SubagentCardProps) {
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState("");
  const [steering, setSteering] = useState(false);
  const [sending, setSending] = useState(false);
  const terminal = isTerminalSubagent(agent.status);
  const failed = agent.status === "failed" || agent.status === "interrupted";
  const act = async (action: () => void | Promise<void>, success: string) => {
    setSending(true);
    try { await action(); setFeedback(success); } catch (cause) { setFeedback(cause instanceof Error ? cause.message : "Action failed"); } finally { setSending(false); }
  };
  const tail = tailText ?? tails?.[agent.id];
  const latest = terminal ? agent.summary : agent.activity.at(-1)?.text;
  const stats = [agent.toolCount ? `${agent.toolCount} ${agent.toolCount === 1 ? "tool" : "tools"}` : "", agent.filesRead.length ? `${agent.filesRead.length} read` : "", agent.filesWritten.length ? `${agent.filesWritten.length} written` : "", agent.inputTokens || agent.outputTokens ? `${compact((agent.inputTokens ?? 0) + (agent.outputTokens ?? 0))} tokens` : "", agent.model ?? ""].filter(Boolean).join(" · ");
  const status = !terminal ? "Running" : agent.status === "failed" ? "Failed" : agent.status === "interrupted" ? "Stopped" : "Done";
  const Icon = failed ? CircleAlert : null;
  const avatarProfile = agent.profile ?? profile;
  return <section aria-label={`Subagent: ${agent.goal}`} data-subagent-id={agent.id} className="min-w-0">
    <details className="group/agent">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/agent:rotate-90" />
        {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0 text-[var(--color-error)]" /> : avatarProfile ? <span data-subagent-avatar={avatarProfile} className={terminal ? "opacity-60" : "todo-node-active"}><ProfileAvatar name={avatarProfile} className="size-4" /></span> : terminal ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-[var(--color-text-muted)]" /> : <span aria-hidden="true" className="todo-node-active size-2 shrink-0 rounded-full bg-[var(--color-accent)]" />}
        <span className="min-w-0 flex-1 truncate font-medium">{agent.goal}</span>
        <span className={chipClass}>{status} · <Elapsed startedAt={agent.startedAt} completedAt={terminal ? agent.updatedAt : undefined} seconds={terminal ? agent.durationSeconds : undefined} /></span>
      </summary>
      <div className="space-y-1 pb-2 pl-5 text-[11px] leading-5 text-[var(--color-text-muted)]">
        {stats && <p>{stats}</p>}
        {latest && <p className="line-clamp-3 break-words">{!terminal ? "Now: " : ""}{latest}</p>}
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className={actionClass} disabled={sending} onClick={() => void act(() => callbacks.onSubagentTail(agent.id), "")}>View output</button>
          {!terminal && <button type="button" className={actionClass} disabled={sending} aria-expanded={steering} onClick={() => setSteering(!steering)}>Steer</button>}
          {!terminal && <button type="button" className={actionClass} disabled={sending} onClick={() => void act(() => callbacks.onSubagentInterrupt(agent.id), "Stop requested")}>Stop</button>}
        </div>
        {steering && !terminal && <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); if (text.trim()) void act(async () => { await callbacks.onSubagentSteer(agent.id, text.trim()); setText(""); setSteering(false); }, "Steer queued, not yet delivered"); }}>
          <input aria-label="Steer subagent" autoFocus className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-transparent px-2 py-0.5 text-[11px] text-[var(--color-text)]" disabled={sending} value={text} onChange={event => setText(event.target.value)} placeholder="Tell it what to do differently" />
          <button className={actionClass} type="submit" disabled={sending || !text.trim()}>Send</button>
        </form>}
        {tail !== undefined && <pre aria-label="Subagent tail" className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-surface-hover)] p-2 font-mono text-[11px] leading-5 text-[var(--color-text)]">{tail}</pre>}
        <p role="status">{feedback}</p>
      </div>
    </details>
    {agent.children.length > 0 && <div className="ml-5" aria-label="Child subagents">{agent.children.map(child => <SubagentCard key={child.id} agent={child} callbacks={callbacks} tails={tails} profile={profile} />)}</div>}
  </section>;
}
export interface ErrorCardProps { error?: ErrorSurface | null; message?: string; partial?: boolean; onRetry?: NativeTranscriptCallbacks["onRetry"] }
/** A failed turn: plain-language title and next step; the raw Hermes text stays folded under Details. */
export function ErrorCard({ error, message, partial, onRetry }: ErrorCardProps) {
  const [retrying, setRetrying] = useState(false);
  const [failure, setFailure] = useState("");
  const copy = describeError(message, error);
  const resets = error?.resets_at != null ? new Date(error.resets_at < 1e12 ? error.resets_at * 1000 : error.resets_at) : null;
  return <section role="alert" data-error-code={error?.code} className="flex gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--color-error)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-error)_6%,transparent)] px-3 py-2.5 text-[13px] leading-5">
    <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--color-error)]" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="font-medium text-[var(--color-text)]">{copy.title}</p>
      {(copy.hint || partial || resets) && <p className="flex flex-wrap gap-x-1.5 text-[12px] text-[var(--color-text-muted)]">
        {[copy.hint, partial ? "Partial response retained" : "", resets ? `Resets at ${resets.toLocaleString()}` : ""].filter(Boolean).map((part, index) => <span key={index} className="contents">{index > 0 && <span aria-hidden="true">·</span>}<span>{part}</span></span>)}
      </p>}
      {copy.detail && <details className="group/err text-[11px] text-[var(--color-text-muted)]">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden"><ChevronRight aria-hidden="true" className="size-3 transition-transform group-open/err:rotate-90" />Details</summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">{copy.detail}</pre>
      </details>}
      {error?.retryable && onRetry && <button type="button" className={`${buttonClass} mt-1 text-[12px]`} disabled={retrying} onClick={async () => { setRetrying(true); try { await onRetry(); } catch (cause) { setFailure(cause instanceof Error ? cause.message : "Retry failed"); } finally { setRetrying(false); } }}>Retry</button>}
      {failure && <p className="text-[12px] text-[var(--color-error)]">{failure}</p>}
    </div>
  </section>;
}
export interface ReadOnlyNoticeProps { source: string; onBranch(): void | Promise<void> }
export function ReadOnlyNotice({ source, onBranch }: ReadOnlyNoticeProps) {
  const [branching, setBranching] = useState(false);
  const [error, setError] = useState("");
  return <aside className={cardClass} aria-label="Read-only conversation"><p>This {source} conversation is read-only. Continue in a new chat to send messages. The branch copies visible messages, not the tool transcript.</p><button type="button" className={buttonClass} disabled={branching} onClick={async () => { setBranching(true); try { await onBranch(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create chat"); } finally { setBranching(false); } }}>Continue as new chat</button>{error && <p role="alert">{error}</p>}</aside>;
}
