"use client";

import { useRef } from "react";
import type { ChatState } from "@/lib/hermes-chat/reducer";
import { buildSubagentTree, isTerminalSubagent, type Subagent, type SubagentNode, type SubagentState } from "@/lib/hermes-chat/subagents";
import { ApprovalCard, ClarifyCard } from "./requests";
import { SubagentCard } from "./panels";
import { TodoPanel } from "./todo-panel";
import { GoalCard, type GoalControl } from "./goal-card";
import type { GoalSnapshot } from "@/lib/hermes-chat/goal";
import { ProfileAvatar } from "../workspace/profile-avatar";
import type { TodoState } from "@/lib/hermes-chat/todos";
import { ChevronRight, Clock3, CornerDownRight } from "lucide-react";
import type { NativeTranscriptCallbacks } from "./types";

/**
 * Everything the agent needs from you, or is running on the side, docks on top of the input box instead of
 * scrolling away in the transcript: questions, approvals, and subagents with their own activity.
 */
export function PromptDock({ state, subagents, todos, profile, tails, callbacks, composerTarget, disabled, queued = [], goal = null, busy = false, onGoalControl }: {
  state: Pick<ChatState, "pendingRequests" | "sessionId">;
  subagents: SubagentState;
  todos?: TodoState;
  /** Profile of this solo chat; shown on subagents, which inherit it. Omitted in group chats. */
  profile?: string | null;
  tails?: Readonly<Record<string, string>>;
  callbacks: NativeTranscriptCallbacks;
  composerTarget?: HTMLElement | null;
  disabled?: boolean;
  /** Messages sent during the running turn that Hermes has not picked up yet. */
  queued?: readonly QueuedItem[];
  /** The chat's standing goal; shown above the tasks. */
  goal?: GoalSnapshot | null;
  busy?: boolean;
  onGoalControl?: GoalControl;
}) {
  const requests = state.pendingRequests;
  const activeKey = useRef<string | null>(null);
  const front = requests.find(request => request.kind === "clarify" && `${state.sessionId}-${request.id}` === activeKey.current)
    ?? requests.find(request => request.kind === "clarify");
  activeKey.current = front ? `${state.sessionId}-${front.id}` : null;
  const roots = buildSubagentTree(subagents.items);
  const hasTodos = !!todos && (todos.visible.length > 0 || todos.retained.length > 0);
  const showGoal = Boolean(goal && onGoalControl);
  if (!requests.length && !roots.length && !hasTodos && !queued.length && !showGoal) return null;
  return <div className="w-full" data-prompt-dock>
    {queued.length > 0 && <QueueList items={queued} />}
    {requests.map(request => request.kind === "approval"
      ? <ApprovalCard key={`${state.sessionId}-${request.id}`} request={request} onApproval={callbacks.onApproval} />
      : request === front || composerTarget === undefined ? <ClarifyCard key={`${state.sessionId}-${request.id}`} request={request} onClarify={callbacks.onClarify} composerTarget={composerTarget} disabled={disabled} /> : <p key={request.id} className="px-3 py-2 text-[12px] text-[var(--color-text-muted)]">Another question is waiting</p>)}
    {goal && onGoalControl && <div className="px-1"><GoalCard goal={goal} busy={busy} onControl={onGoalControl} /></div>}
    {todos && hasTodos && <div className="px-1 pb-1"><TodoPanel todos={todos} /></div>}
    {roots.length > 0 && <SubagentGroup roots={roots} callbacks={callbacks} tails={tails} profile={profile} />}
  </div>;
}

export interface QueuedItem { id: string; text: string; steer: boolean }
/** One flat line per waiting message: what it is, its text, and when Hermes will pick it up. */
function QueueList({ items }: { items: readonly QueuedItem[] }) {
  return <ul aria-label="Waiting messages" data-queue className="space-y-0.5 px-3 pt-2 pb-1">
    {items.map(item => {
      const Icon = item.steer ? CornerDownRight : Clock3;
      return <li key={item.id} data-queued-id={item.id} data-steer={item.steer || undefined} className="flex min-h-6 items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
        <Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">{item.steer ? "Steer" : "Queued"}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--color-text)]" title={item.text}>{item.text}</span>
        <span className="shrink-0">{item.steer ? "after this step" : "next"}</span>
      </li>;
    })}
  </ul>;
}

const flatten = (nodes: readonly SubagentNode[]): Subagent[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
/** All subagents behind one line: "2 subagents running · 1 done". Open it for one accordion per subagent. */
function SubagentGroup({ roots, callbacks, tails, profile }: { roots: readonly SubagentNode[]; callbacks: NativeTranscriptCallbacks; tails?: Readonly<Record<string, string>>; profile?: string | null }) {
  const all = flatten(roots);
  const running = all.filter(agent => !isTerminalSubagent(agent.status)).length;
  const finished = all.length - running;
  const plural = (count: number) => `${count} ${count === 1 ? "subagent" : "subagents"}`;
  const label = running ? `${plural(running)} running${finished ? ` · ${finished} done` : ""}` : `${plural(all.length)} finished`;
  // Running state is shown by the agents' profile icons (one per distinct profile), never the pixel grid.
  const profiles = [...new Set((running ? all.filter(agent => !isTerminalSubagent(agent.status)) : all).map(agent => agent.profile ?? profile).filter((name): name is string => !!name))].slice(0, 3);
  return <details className="group/agents px-3 pt-1 pb-2" aria-label="Subagents">
    <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform motion-reduce:transition-none group-open/agents:rotate-90" />
      <span data-group-avatars className="flex shrink-0 -space-x-1.5">
        {profiles.length ? profiles.map(name => <span key={name} data-group-avatar={name} className={running ? "todo-node-active" : "opacity-60"}><ProfileAvatar name={name} className="size-4 ring-2 ring-[var(--color-surface)]" /></span>)
          : <span aria-hidden="true" className={`size-2 rounded-full bg-[var(--color-accent)] ${running ? "todo-node-active" : "opacity-40"}`} />}
      </span>
      <span role={running ? "status" : undefined} className={`font-medium ${running ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>{label}</span>
    </summary>
    <div className="max-h-[40dvh] overflow-y-auto pb-1">{roots.map(agent => <SubagentCard key={agent.id} agent={agent} callbacks={callbacks} tails={tails} profile={profile} />)}</div>
  </details>;
}
