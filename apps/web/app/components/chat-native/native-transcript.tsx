"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Clock3 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { NativeTranscriptProps } from "./types";
import { ErrorCard } from "./panels";
import { displayTurns, WorkBlock } from "./work-block";
import { transcriptBlocks } from "./transcript-blocks";
import { NoticeLine } from "./notice-line";
import { AttachmentChips } from "./attachment-chips";
import { parseUserAttachments } from "./attachments";
import { hasArtifactBlocks, splitArtifactBlocks } from "@/lib/mail-artifacts";
import { MailDraftCard } from "../mail-draft-card";
import { splitVisualBlocks } from "@/lib/visual-blocks";
import { VisualBlock } from "./visual-block";

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
function AnswerText({ text, live, renderMarkdown, onOpenArtifact, onSendPrompt }: { text: string; live: boolean; renderMarkdown?: (text: string) => ReactNode; onOpenArtifact?: NativeTranscriptProps["onOpenArtifact"]; onSendPrompt?: NativeTranscriptProps["onSendPrompt"] }) {
  const markdown = (value: string) => renderMarkdown ? renderMarkdown(value) : <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>;
  const withArtifacts = (value: string, keyPrefix: string) => !hasArtifactBlocks(value) ? markdown(value) : <>{splitArtifactBlocks(value).map((piece, index) => piece.type === "artifact"
    ? <MailDraftCard key={`${keyPrefix}-artifact-${index}-${piece.artifact.id}`} artifact={piece.artifact} autoOpen={live} onOpen={onOpenArtifact} />
    : <Fragment key={`${keyPrefix}-text-${index}`}>{markdown(piece.text)}</Fragment>)}</>;
  return <>{splitVisualBlocks(text).map((piece, index) => piece.type === "visual"
    ? <VisualBlock key={`visual-${index}`} code={piece.code} closed={piece.closed} onSendPrompt={onSendPrompt} />
    : <Fragment key={`piece-${index}`}>{withArtifacts(piece.text, `p${index}`)}</Fragment>)}</>;
}
export function NativeTranscript({ state, callbacks, renderMarkdown, userHtml, queuedMessageIds = [], onOpenArtifact, onSendPrompt }: NativeTranscriptProps) {
  const turns = displayTurns(state.messages);
  // Retry re-runs the latest turn, so only the latest failure offers it.
  return <div className="space-y-2 text-sm text-[var(--color-text-primary)]" aria-label="Native Hermes transcript">
    {turns.map((message, index) => message.notice ? <NoticeLine key={message.id} notice={message.notice} onCancel={message.notice.pending ? callbacks.onCancelNotice : undefined} /> : <article key={message.id} aria-label={`${message.role} message`} className={message.role === "user" ? "" : "space-y-2 py-3"} data-message-id={message.id}>
      {message.role === "user" ? (() => {
        const { attachments, message: body } = parseUserAttachments(message.segments.filter(segment => segment.type !== "tool").map(segment => segment.text).join(""));
        const queued = queuedMessageIds.includes(message.id);
        return <div className="flex flex-col items-end gap-1.5 py-2">
          <AttachmentChips attachments={attachments} />
          {(body || !attachments.length || queued) && <div data-queued={queued || undefined} className={`max-w-[80%] min-w-0 rounded-2xl rounded-br-sm px-3 py-2 text-sm leading-6 overflow-hidden break-words chat-message-font ${queued ? "border border-dashed border-[var(--color-border)] bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]" : ""}`} style={queued ? undefined : { background: "var(--color-user-bubble)", color: "var(--color-user-bubble-text)" }}>
            {queued && <span className="mb-1 flex w-fit items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs font-medium"><Clock3 aria-hidden="true" className="size-3" />Queued</span>}
            <UserContent html={attachments.length ? undefined : userHtml?.(message.id)} text={body} />
          </div>}
          {queued && <span className="text-xs text-[var(--color-text-muted)]">Waiting for the current turn to finish</span>}
        </div>;
      })() : (() => {
        const blocks = transcriptBlocks(message.segments);
        return <Fragment key={message.id}>
          {blocks.map((block, index) => {
            const next = blocks[index + 1];
            return block.type === "work"
              ? <WorkBlock key={block.id} work={block.segments} live={state.live && message.pending && !message.steerBoundary && (index === blocks.length - 1 || block.segments.some(segment => segment.type === "tool" && segment.status === "running"))} answerStartedAt={next?.type === "answer" ? next.segment.startedAt : undefined} />
              : <div key={block.id} data-segment={block.segment.type} className="chat-prose chat-message-font text-sm break-words"><AnswerText text={block.segment.text} live={state.live && message.pending} renderMarkdown={renderMarkdown} onOpenArtifact={onOpenArtifact} onSendPrompt={onSendPrompt} /></div>;
          })}
        </Fragment>;
      })()}
      {(message.error_surface || message.error) && <ErrorCard error={message.error_surface} message={message.error} partial={message.partial} onRetry={index === turns.length - 1 || turns.slice(index + 1).every(item => item.notice) ? callbacks.onRetry : undefined} />}
    </article>)}
    <p role="status">{state.pendingRequests.some(request => request.kind === "approval") ? "Waiting for approval" : state.pendingRequests.some(request => request.kind === "clarify") ? "Waiting for your answer" : state.interrupted ? "Interrupted" : ""}</p>
  </div>;
}
