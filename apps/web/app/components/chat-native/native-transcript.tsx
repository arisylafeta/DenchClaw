"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PendingRequest } from "@/lib/hermes-chat/reducer";
import { buildSubagentTree } from "@/lib/hermes-chat/subagents";
import type { NativeTranscriptProps } from "./types";
import { ApprovalCard, ClarifyCard } from "./requests";
import { ErrorCard, SubagentCard, TodoPanel } from "./panels";
import { displayTurns, splitTurn, WorkBlock } from "./work-block";
import { AttachmentChips } from "./attachment-chips";
import { parseUserAttachments } from "./attachments";

function UserContent({ html, text }: { html?: string; text: string }) {
  const [content, setContent] = useState<ReactNode>(text);
  useEffect(() => {
    if (!html) { setContent(text); return; }
    const doc = new DOMParser().parseFromString(html, "text/html");
    const render = (node: Node, key: number): ReactNode => {
      if (node.nodeType === 3) return node.textContent;
      if (!(node instanceof Element) || ["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(node.tagName)) return null;
      if (node.tagName === "BR") return <br key={key} />;
      const children = Array.from(node.childNodes).map(render);
      if (node.tagName === "SPAN" && (node.hasAttribute("data-type") || node.className.includes("mention"))) return <span key={key} className="rounded bg-white/15 px-1 font-medium">{children}</span>;
      return <span key={key}>{children}</span>;
    };
    setContent(Array.from(doc.body.childNodes).map(render));
  }, [html, text]);
  return <div className="whitespace-pre-wrap break-words">{content}</div>;
}
export function NativeTranscript({ state, subagents = state.subagents, todos = state.todos, callbacks, renderMarkdown, userHtml, queuedMessageIds = [], subagentTails }: NativeTranscriptProps) {
  const [requests, setRequests] = useState<PendingRequest[]>(state.pendingRequests);
  useEffect(() => {
    setRequests(previous => [...previous.filter(old => !state.pendingRequests.some(current => current.id === old.id)), ...state.pendingRequests]);
  }, [state.pendingRequests]);
  // A session switch must not carry request cards into the next conversation.
  useEffect(() => { setRequests(state.pendingRequests); }, [state.sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const visibleRequests = [...requests.filter(old => !state.pendingRequests.some(current => current.id === old.id)), ...state.pendingRequests];
  return <div className="space-y-2 text-sm text-[var(--color-text-primary)]" aria-label="Native Hermes transcript">
    {displayTurns(state.messages).map(message => <article key={message.id} aria-label={`${message.role} message`} className={message.role === "user" ? "" : "space-y-2 py-3"} data-message-id={message.id}>
      {message.role === "user" ? (() => { const { attachments, message: body } = parseUserAttachments(message.segments.filter(segment => segment.type !== "tool").map(segment => segment.text).join("")); return <div className="flex flex-col items-end gap-1.5 py-2"><AttachmentChips attachments={attachments} />{(body || !attachments.length) && <div className="max-w-[80%] min-w-0 rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-6 overflow-hidden break-words chat-message-font" style={{ background: "var(--color-user-bubble)", color: "var(--color-user-bubble-text)" }}><UserContent html={attachments.length ? undefined : userHtml?.(message.id)} text={body} /></div>}{queuedMessageIds.includes(message.id) && <span className="text-xs text-[var(--color-text-muted)]">Queued</span>}</div>; })() : (() => {
        const { work, answer } = splitTurn(message.segments);
        return <Fragment key={message.id}>
          {work.length > 0 && <WorkBlock work={work} live={state.live && message.pending} answerStartedAt={answer[0]?.startedAt} />}
          {answer.map(segment => <div key={segment.id} data-segment={segment.type} className="chat-prose chat-message-font text-sm break-words">{renderMarkdown ? renderMarkdown(segment.text) : <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.text}</ReactMarkdown>}</div>)}
        </Fragment>;
      })()}
      {message.error_surface ? <ErrorCard error={message.error_surface} message={message.error} partial={message.partial} onRetry={callbacks.onRetry} /> : message.error ? <p role="alert">{message.error}</p> : null}
    </article>)}
    {visibleRequests.map(request => request.kind === "approval" ? <ApprovalCard key={`${state.sessionId}-${request.id}`} request={request} active={state.pendingRequests.some(current => current.id === request.id)} onApproval={callbacks.onApproval} /> : <ClarifyCard key={`${state.sessionId}-${request.id}`} request={request} active={state.pendingRequests.some(current => current.id === request.id)} onClarify={callbacks.onClarify} />)}
    {buildSubagentTree(subagents.items).map((agent, index, roots) => <SubagentCard key={agent.id} agent={agent} callbacks={callbacks} tails={subagentTails} connectPrevious={index > 0} connectNext={index < roots.length - 1} />)}
    <TodoPanel todos={todos} />
    <p role="status">{state.pendingRequests.some(request => request.kind === "approval") ? "Waiting for approval" : state.pendingRequests.some(request => request.kind === "clarify") ? "Waiting for your answer" : state.interrupted ? "Interrupted" : ""}</p>
  </div>;
}
