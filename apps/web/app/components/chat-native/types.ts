import type { ReactNode } from "react";
import type { ChatState, PendingRequest } from "@/lib/hermes-chat/reducer";
import type { SubagentState } from "@/lib/hermes-chat/subagents";
import type { TodoState } from "@/lib/hermes-chat/todos";

export type ApprovalChoice = "once" | "session" | "always" | "deny";
export interface NativeTranscriptCallbacks {
  onApproval(request: PendingRequest, choice: ApprovalChoice): void | Promise<void>;
  onClarify(request: PendingRequest, answers: Record<string, string | null>): void | Promise<void>;
  onSubagentTail(id: string): void | Promise<void>;
  onSubagentSteer(id: string, text: string): void | Promise<void>;
  onSubagentInterrupt(id: string): void | Promise<void>;
  onCancelNotice?(): void;
  onRetry(): void | Promise<void>;
}
export interface NativeTranscriptProps {
  state: ChatState;
  subagents?: SubagentState;
  todos?: TodoState;
  callbacks: NativeTranscriptCallbacks;
  renderMarkdown?: (text: string) => ReactNode;
  /** HTML is parsed as inert formatting/mention spans, never inserted as executable HTML. */
  userHtml?: (messageId: string) => string | undefined;
  queuedMessageIds?: readonly string[];
  subagentTails?: Readonly<Record<string, string>>;
}
