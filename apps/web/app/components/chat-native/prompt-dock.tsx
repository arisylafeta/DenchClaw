"use client";

import { useRef } from "react";
import type { ChatState } from "@/lib/hermes-chat/reducer";
import { buildSubagentTree, isTerminalSubagent, type Subagent, type SubagentNode, type SubagentState } from "@/lib/hermes-chat/subagents";
import { ApprovalCard, ClarifyCard } from "./requests";
import { SubagentCard } from "./panels";
import { TodoPanel } from "./todo-panel";
import { ProfileAvatar } from "../workspace/profile-avatar";
import type { TodoState } from "@/lib/hermes-chat/todos";
import { ThinkingIndicator } from "./thinking";
import { ChevronRight } from "lucide-react";
import type { NativeTranscriptCallbacks } from "./types";

/**
 * Everything the agent needs from you, or is running on the side, docks on top of the input box instead of
 * scrolling away in the transcript: questions, approvals, and subagents with their own activity.
 */
export function PromptDock({ state, subagents, todos, profile, tails, callbacks, composerTarget, disabled }: {
  state: Pick<ChatState, "pendingRequests" | "sessionId">;
  subagents: SubagentState;
  todos?: TodoState;
  /** Profile of this solo chat; shown on subagents, which inherit it. Omitted in group chats. */
  profile?: string | null;
  tails?: Readonly<Record<string, string>>;
  callbacks: NativeTranscriptCallbacks;
  composerTarget?: HTMLElement | null;
  disabled?: boolean;
}) {
  const requests = state.pendingRequests;
  const activeKey = useRef<string | null>(null);
  const front = requests.find(request => request.kind === "clarify" && `${state.sessionId}-${request.id}` === activeKey.current)
    ?? requests.find(request => request.kind === "clarify");
  activeKey.current = front ? `${state.sessionId}-${front.id}` : null;
  const roots = buildSubagentTree(subagents.items);
  const hasTodos = !!todos && (todos.visible.length > 0 || todos.retained.length > 0);
  if (!requests.length && !roots.length && !hasTodos) return null;
  return <div className="w-full" data-prompt-dock>
    {requests.map(request => request.kind === "approval"
      ? <ApprovalCard key={`${state.sessionId}-${request.id}`} request={request} onApproval={callbacks.onApproval} />
      : request === front || composerTarget === undefined ? <ClarifyCard key={`${state.sessionId}-${request.id}`} request={request} onClarify={callbacks.onClarify} composerTarget={composerTarget} disabled={disabled} /> : <p key={request.id} className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">Another question is waiting</p>)}
    {todos && hasTodos && <div className="px-1 pb-1"><TodoPanel todos={todos} /></div>}
    {roots.length > 0 && <SubagentGroup roots={roots} callbacks={callbacks} tails={tails} profile={profile} />}
  </div>;
}

const flatten = (nodes: readonly SubagentNode[]): Subagent[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
/** All subagents behind one line: "2 subagents running · 1 done". Open it for one accordion per subagent. */
function SubagentGroup({ roots, callbacks, tails, profile }: { roots: readonly SubagentNode[]; callbacks: NativeTranscriptCallbacks; tails?: Readonly<Record<string, string>>; profile?: string | null }) {
  const all = flatten(roots);
  const running = all.filter(agent => !isTerminalSubagent(agent.status)).length;
  const finished = all.length - running;
  const plural = (count: number) => `${count} ${count === 1 ? "subagent" : "subagents"}`;
  const label = running ? `${plural(running)} running${finished ? ` · ${finished} done` : ""}` : `${plural(all.length)} finished`;
  return <details className="group/agents px-3 pt-1 pb-2" aria-label="Subagents">
    <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform motion-reduce:transition-none group-open/agents:rotate-90" />
      {profile && <span data-group-avatar={profile} className={running ? "todo-node-active" : "opacity-60"}><ProfileAvatar name={profile} className="size-4" /></span>}
      {running ? <ThinkingIndicator>{label}</ThinkingIndicator> : <span className="font-medium text-[var(--color-text-muted)]">{label}</span>}
    </summary>
    <div className="max-h-[40dvh] overflow-y-auto pb-1">{roots.map(agent => <SubagentCard key={agent.id} agent={agent} callbacks={callbacks} tails={tails} profile={profile} />)}</div>
  </details>;
}
