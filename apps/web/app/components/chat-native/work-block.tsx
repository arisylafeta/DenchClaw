"use client";

import { useEffect, useState } from "react";
import { Brain, ChevronRight, LoaderCircle, MessageSquareText } from "lucide-react";
import type { Segment, TextSegment } from "@/lib/hermes-chat/reducer";
import { chipClass, Elapsed, ToolRow, TraceStep } from "./tool-run";

/** Everything before the final answer is "work": reasoning, tool calls and the narration between them. */
export function splitTurn(segments: readonly Segment[]): { work: Segment[]; answer: TextSegment[] } {
  let lastWork = -1;
  segments.forEach((segment, index) => { if (segment.type !== "text") lastWork = index; });
  const visible = (segment: Segment) => segment.type === "tool" || segment.text.trim() !== "";
  return { work: segments.slice(0, lastWork + 1).filter(visible), answer: segments.slice(lastWork + 1).filter((segment): segment is TextSegment => segment.type !== "tool" && visible(segment)) };
}
function useLiveDisclosure(live: boolean) {
  const [open, setOpen] = useState(live);
  const [manual, setManual] = useState(false);
  useEffect(() => { if (!manual) setOpen(live); }, [live, manual]);
  return { open, onToggle: (event: { currentTarget: { open: boolean } }) => { if (event.currentTarget.open !== open) { setManual(true); setOpen(event.currentTarget.open); } } };
}
const clip = (text: string, max = 140) => { const line = text.replace(/\s+/g, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return whole < 60 ? `${whole}s` : `${Math.floor(whole / 60)}m ${whole % 60}s`;
}
export interface WorkBlockProps { work: readonly Segment[]; live: boolean; answerStartedAt?: number }
/** One continuous trace for the whole turn. Open while the agent works, folded into "Thought for Xs" afterwards. */
export function WorkBlock({ work, live, answerStartedAt }: WorkBlockProps) {
  const disclosure = useLiveDisclosure(live);
  const items = work.filter(segment => segment.type !== "reasoning" || live || (segment.completedAt ?? segment.startedAt) - segment.startedAt >= 1000);
  const started = work[0]?.startedAt ?? 0;
  const ended = Math.max(...work.map(segment => segment.completedAt ?? segment.startedAt), answerStartedAt ?? 0);
  const steps = work.filter(segment => segment.type === "tool").length;
  return <details className="group/work w-full min-w-0" data-segment="work" open={disclosure.open} onToggle={disclosure.onToggle}>
    <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 text-[12px] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/work:rotate-90" />
      {live ? <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin text-[var(--color-text-muted)] motion-reduce:animate-none" /> : <Brain aria-hidden="true" className="size-3.5 text-[var(--color-text-muted)]" />}
      <span className="font-medium">{live ? "Working" : "Thought for"} {live ? <Elapsed startedAt={started} /> : formatDuration((ended - started) / 1000)}</span>
      {steps > 0 && <span className={chipClass}>{steps} {steps === 1 ? "step" : "steps"}</span>}
    </summary>
    <div className="mt-1 ml-1.5">
      {items.map((segment, index) => {
        const connect = { connectPrevious: index > 0, connectNext: index < items.length - 1 };
        if (segment.type === "tool") return <ToolRow key={segment.id} tool={segment} {...connect} />;
        if (segment.type === "reasoning") return <TraceStep key={segment.id} data-segment="reasoning" state={live && segment.completedAt === undefined ? "running" : "done"} label="Thought" detail={segment.completedAt === undefined ? undefined : <Elapsed startedAt={segment.startedAt} completedAt={segment.completedAt} />} {...connect} />;
        return <TraceStep key={segment.id} data-segment={segment.type} state="done" icon={MessageSquareText} label={clip(segment.text)} muted {...connect} />;
      })}
    </div>
  </details>;
}
