"use client";

import { useEffect, useState } from "react";
import { formatElapsedDuration } from "@/lib/elapsed-duration";
import { Brain, ChevronRight, MessageSquareText } from "lucide-react";
import { ThinkingIndicator } from "./thinking";
import type { ChatMessage, Segment, TextSegment } from "@/lib/hermes-chat/reducer";
import { Elapsed, ToolRow, TraceStep } from "./tool-run";

/** Everything before the final answer is "work": reasoning, tool calls and the narration between them. */
export function splitTurn(segments: readonly Segment[]): { work: Segment[]; answer: TextSegment[] } {
  const visible = (segment: Segment) => segment.type === "tool" || segment.text.trim() !== "";
  // Reasoning that arrives after the answer text (late summaries) is still work; it must not demote the answer.
  let end = segments.length;
  const lastAnswer = segments.findLastIndex(segment => segment.type !== "tool" && segment.type !== "reasoning" && visible(segment));
  if (lastAnswer >= 0 && segments.slice(lastAnswer + 1).every(segment => segment.type === "reasoning")) end = lastAnswer + 1;
  const body = segments.slice(0, end);
  const trailing = segments.slice(end);
  let lastWork = -1;
  body.forEach((segment, index) => { if (segment.type !== "text") lastWork = index; });
  return {
    work: [...body.slice(0, lastWork + 1), ...trailing].filter(visible),
    answer: body.slice(lastWork + 1).filter((segment): segment is TextSegment => segment.type !== "tool" && visible(segment)),
  };
}

/**
 * Hermes stores one assistant row per model call, so a turn with N tool rounds is N consecutive assistant
 * messages. For the reader that is one turn: merge them, starting at the moment the prompt was sent when known.
 */
export function displayTurns(messages: readonly ChatMessage[]): ChatMessage[] {
  const turns: ChatMessage[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (message.notice || message.role !== "assistant") { turns.push(message); continue; }
    if (previous?.role === "assistant" && !previous.notice) {
      turns[turns.length - 1] = { ...previous, segments: [...previous.segments, ...message.segments], pending: message.pending, steerBoundary: message.steerBoundary, completedAt: message.completedAt,
        error: message.error ?? previous.error, error_surface: message.error_surface ?? previous.error_surface, partial: message.partial ?? previous.partial, status: message.status ?? previous.status };
      continue;
    }
    const first = message.segments[0];
    const asked = previous?.role === "user" ? previous.startedAt : 0;
    turns.push(first && asked > 0 && first.startedAt > asked ? { ...message, segments: [{ ...first, startedAt: asked }, ...message.segments.slice(1)] } : message);
  }
  return turns;
}
function useLiveDisclosure(live: boolean, initiallyOpen = false) {
  const [open, setOpen] = useState(live || initiallyOpen);
  const [manual, setManual] = useState(initiallyOpen);
  useEffect(() => { if (!manual) setOpen(live); }, [live, manual]);
  return { open, onToggle: (event: { currentTarget: { open: boolean } }) => { if (event.currentTarget.open !== open) { setManual(true); setOpen(event.currentTarget.open); } } };
}
/** Hermes decorates status and narration with emoji; the transcript shows plain text. */
export const stripEmoji = (text: string) => text.replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u200d\ufe0f\u20e3\u{1F3FB}-\u{1F3FF}]/gu, "").replace(/[ \t]{2,}/g, " ").trim();
const clip = (text: string, max = 140) => { const line = stripEmoji(text).replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

export interface WorkBlockProps { work: readonly Segment[]; live: boolean; answerStartedAt?: number; initiallyOpen?: boolean }
/** One continuous trace for the whole turn. Open while the agent works, folded into "Thought for Xs" afterwards. */
export function WorkBlock({ work, live, answerStartedAt, initiallyOpen }: WorkBlockProps) {
  const disclosure = useLiveDisclosure(live, initiallyOpen);
  // History has no per-part durations; text must remain readable after reload.
  const items = work.filter(segment => segment.type !== "reasoning" || segment.text.trim() || live || (segment.completedAt ?? segment.startedAt) - segment.startedAt >= 1000);
  const started = work[0]?.startedAt ?? 0;
  const ended = Math.max(...work.map(segment => segment.completedAt ?? segment.startedAt), answerStartedAt ?? 0);
  const seconds = (ended - started) / 1000;
  // A failed tool turns the header red; it never opens the block.
  const failed = work.some(segment => segment.type === "tool" && (segment.status === "error" || Boolean(segment.error)));
  return <details className="group/work w-full min-w-0" data-segment="work" data-failed={failed || undefined} open={disclosure.open} onToggle={disclosure.onToggle}>
    <summary className={`flex min-h-6 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden${failed ? " text-[var(--color-error)]" : ""}`}>
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/work:rotate-90" />
      {live
        ? <ThinkingIndicator>Thinking <Elapsed startedAt={started} /></ThinkingIndicator>
        : <><Brain aria-hidden="true" className={`size-3.5 ${failed ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`} /><span className="font-medium">{seconds >= 1 ? `Thought for ${formatElapsedDuration(seconds)}` : "Thought"}</span></>}
    </summary>
    <div className="mt-1 ml-1.5">
      {items.map((segment, index) => {
        const connect = { connectPrevious: index > 0, connectNext: index < items.length - 1 };
        if (segment.type === "tool") return <ToolRow key={segment.id} tool={segment} {...connect} />;
        if (segment.type === "reasoning") return <TraceStep key={segment.id} data-segment="reasoning" state={live && segment.completedAt === undefined ? "running" : "done"} label={segment.text.trim() ? <span className="block whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{segment.text}</span> : "Thought"} muted={Boolean(segment.text.trim())} detail={segment.completedAt === undefined ? undefined : <Elapsed startedAt={segment.startedAt} completedAt={segment.completedAt} />} {...connect} />;
        return <TraceStep key={segment.id} data-segment={segment.type} state="done" icon={MessageSquareText} label={clip(segment.text)} muted {...connect} />;
      })}
    </div>
  </details>;
}
