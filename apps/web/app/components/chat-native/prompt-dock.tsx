"use client";

import type { ChatState } from "@/lib/hermes-chat/reducer";
import { buildSubagentTree, isTerminalSubagent, type Subagent, type SubagentNode, type SubagentState } from "@/lib/hermes-chat/subagents";
import { ApprovalCard, ClarifyCard } from "./requests";
import { SubagentCard } from "./panels";
import { ThinkingIndicator } from "./thinking";
import { ChevronRight } from "lucide-react";
import type { NativeTranscriptCallbacks } from "./types";

/**
 * Everything the agent needs from you, or is running on the side, docks on top of the input box instead of
 * scrolling away in the transcript: questions, approvals, and subagents with their own activity.
 */
export function PromptDock({ state, subagents, tails, callbacks }: {
  state: Pick<ChatState, "pendingRequests" | "sessionId">;
  subagents: SubagentState;
  tails?: Readonly<Record<string, string>>;
  callbacks: NativeTranscriptCallbacks;
}) {
  const requests = state.pendingRequests;
  const roots = buildSubagentTree(subagents.items);
  if (!requests.length && !roots.length) return null;
  return <div className="w-full" data-prompt-dock>
    {requests.map(request => request.kind === "approval"
      ? <ApprovalCard key={`${state.sessionId}-${request.id}`} request={request} onApproval={callbacks.onApproval} />
      : <ClarifyCard key={`${state.sessionId}-${request.id}`} request={request} onClarify={callbacks.onClarify} />)}
    {roots.length > 0 && <SubagentGroup roots={roots} callbacks={callbacks} tails={tails} />}
  </div>;
}

const flatten = (nodes: readonly SubagentNode[]): Subagent[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
/** All subagents behind one line: "2 subagents running · 1 done". Open it for one accordion per subagent. */
function SubagentGroup({ roots, callbacks, tails }: { roots: readonly SubagentNode[]; callbacks: NativeTranscriptCallbacks; tails?: Readonly<Record<string, string>> }) {
  const all = flatten(roots);
  const running = all.filter(agent => !isTerminalSubagent(agent.status)).length;
  const finished = all.length - running;
  const plural = (count: number) => `${count} ${count === 1 ? "subagent" : "subagents"}`;
  const label = running ? `${plural(running)} running${finished ? ` · ${finished} done` : ""}` : `${plural(all.length)} finished`;
  return <details className="group/agents bg-gradient-to-b from-[var(--color-surface-hover)] to-transparent px-3 pt-1 pb-2" aria-label="Subagents">
    <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/agents:rotate-90" />
      {running ? <ThinkingIndicator>{label}</ThinkingIndicator> : <span className="font-medium text-[var(--color-text-muted)]">{label}</span>}
    </summary>
    <div className="max-h-[40dvh] overflow-y-auto pb-1">{roots.map(agent => <SubagentCard key={agent.id} agent={agent} callbacks={callbacks} tails={tails} />)}</div>
  </details>;
}
