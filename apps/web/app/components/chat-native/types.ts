import type { ReactNode } from "react";
import type { ChatState, PendingRequest } from "@/lib/hermes-chat/reducer";
import type { SubagentState } from "@/lib/hermes-chat/subagents";

export type ApprovalChoice = "once" | "session" | "always" | "deny";
export interface NativeTranscriptCallbacks {
  onApproval(request: PendingRequest, choice: ApprovalChoice): void | Promise<void>;
  onClarify(request: PendingRequest, answers: Record<string, string | null>): void | Promise<void>;
  onSubagentTail(id: string): void | Promise<void>;
  onSubagentSteer(id: string, text: string): void | Promise<void>;
  onSubagentInterrupt(id: string): void | Promise<void>;
  onCancelNotice?(): void;
  /** Absent when the viewer cannot write; the failed-turn card then offers no retry. */
  onRetry?(): void | Promise<void>;
}
export interface NativeTranscriptProps {
  state: ChatState;
  subagents?: SubagentState;
  callbacks: NativeTranscriptCallbacks;
  renderMarkdown?: (text: string) => ReactNode;
  /** HTML is parsed as inert formatting/mention spans, never inserted as executable HTML. */
  userHtml?: (messageId: string) => string | undefined;
  queuedMessageIds?: readonly string[];
  /** Opens a workspace path (such as a mail draft artifact) in the content panel. */
  /** Sends a follow-up the user confirmed from inside an agent-drawn visual. */
  onSendPrompt?: (text: string) => void | Promise<void>;
  onOpenArtifact?: (path: string, options?: { title?: string }) => Promise<boolean | void> | boolean | void;
  subagentTails?: Readonly<Record<string, string>>;
}
