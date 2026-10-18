"use client";

import type { ChatState } from "@/lib/hermes-chat/reducer";
import { buildSubagentTree, type SubagentState } from "@/lib/hermes-chat/subagents";
import { ApprovalCard, ClarifyCard } from "./requests";
import { SubagentCard } from "./panels";
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
    {roots.length > 0 && <div className="max-h-[40dvh] overflow-y-auto border-b border-[var(--color-border)] bg-[var(--color-surface-hover)] px-3 py-1" aria-label="Subagents">
      {roots.map((agent, index) => <SubagentCard key={agent.id} agent={agent} callbacks={callbacks} tails={tails} connectPrevious={index > 0} connectNext={index < roots.length - 1} />)}
    </div>}
  </div>;
}
