/**
 * Native gateway transcript UI, intentionally transport-free.
 *
 * The controller supplies reducer state and NativeTranscriptCallbacks; callback
 * promises represent action acceptance, not delivery or turn completion. Request
 * cards retain removed requests as resolved/withdrawn until the session changes.
 * Approval callbacks receive the entire PendingRequest (JSON-RPC id plus approval
 * requestId); clarify callbacks receive qid-keyed answers, with multi-select values
 * joined by ", ". A single option click answers immediately; multi-select/free
 * text use Submit. The controller posts these qid-keyed answers unchanged.
 *
 * userHtml(messageId) is inertly parsed to formatting/mention spans. Queue identity
 * and tail text are controller-owned props, never inferred from model prose.
 * ReadOnlyNotice is rendered by the owner when source policy forbids sending.
 */
export { NativeTranscript, ReasoningBlock } from "./native-transcript";
export type { ReasoningBlockProps } from "./native-transcript";
export { ApprovalCard, ClarifyCard } from "./requests";
export type { ApprovalCardProps, ClarifyCardProps } from "./requests";
export { SubagentCard, TodoPanel, UsageMeter, ErrorCard, ReadOnlyNotice } from "./panels";
export type { SubagentCardProps, TodoPanelProps, UsageMeterProps, ErrorCardProps, ReadOnlyNoticeProps } from "./panels";
export { ToolRun, ToolRow, Elapsed } from "./tool-run";
export type { ToolRunProps, ToolRowProps, ElapsedProps } from "./tool-run";
export type { NativeTranscriptProps, NativeTranscriptCallbacks, ApprovalChoice } from "./types";
