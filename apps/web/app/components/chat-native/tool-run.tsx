"use client";

import { useEffect, useState } from "react";
import { formatElapsedDuration } from "@/lib/elapsed-duration";
import { Brain, ChevronRight, CircleAlert, type LucideIcon } from "lucide-react";
import { PixelGrid } from "./thinking";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { describeTool } from "./describe";
import { buildPreview } from "./preview";
import { ResultPreviewView } from "./preview-view";

export const cardClass = "rounded-lg border border-[var(--color-border)] p-3 space-y-2 text-[13px] leading-5";
export const buttonClass = "rounded border border-[var(--color-border)] px-3 py-1 focus-visible:outline-2 disabled:opacity-50";
export interface ElapsedProps { startedAt: number; completedAt?: number; seconds?: number | null }
export function Elapsed({ startedAt, completedAt, seconds }: ElapsedProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (completedAt !== undefined || seconds != null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [completedAt, seconds]);
  return <span>{formatElapsedDuration(seconds ?? ((completedAt ?? now) - startedAt) / 1000)}</span>;
}
export type StepState = "running" | "done" | "error";
export const chipClass = "min-w-0 rounded-md bg-[var(--color-surface-hover)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-muted)]";
/** One trace step in the rebattery-platform style: status node on a connector line, label, detail chip. No disclosure. */
export function TraceStep({ state, icon, label, detail, body, muted, connectPrevious, connectNext, children, ...rest }: {
  state: StepState; icon?: LucideIcon; label: React.ReactNode; detail?: React.ReactNode; body?: React.ReactNode; muted?: boolean; connectPrevious?: boolean; connectNext?: boolean; children?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const Icon = state === "error" ? CircleAlert : state === "done" ? (icon ?? Brain) : null;
  const row = <>
    <span aria-hidden="true" className="absolute -left-7 flex size-3.5 items-center justify-center bg-[var(--color-main-bg)] text-[var(--color-text-muted)]">
      {Icon ? <Icon className={`size-3.5 ${state === "error" ? "text-[var(--color-error)]" : ""}`} /> : <PixelGrid />}
    </span>
    {label && <span className={muted ? "min-w-0 text-[12px] text-[var(--color-text-muted)]" : "text-[12px] font-medium text-[var(--color-text)]"}>{label}</span>}
    {detail !== undefined && <span className={chipClass}>{detail}</span>}
    {body !== undefined && <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/step:rotate-90" />}
  </>;
  return <div {...rest} className="relative min-w-0 py-1.5 pl-7">
    {connectPrevious && <span aria-hidden="true" className="absolute top-0 bottom-1/2 left-[7px] w-px bg-[var(--color-border)]" />}
    {connectNext && <span aria-hidden="true" className="absolute top-1/2 -bottom-4 left-[7px] w-px bg-[var(--color-border)]" />}
    {body !== undefined
      ? <details className="group/step"><summary className="relative flex min-h-6 cursor-pointer list-none flex-wrap items-center gap-2.5 [&::-webkit-details-marker]:hidden">{row}</summary><div className="mt-1.5">{body}</div></details>
      : <div className="relative flex min-h-6 flex-wrap items-center gap-2.5">{row}</div>}
    {children}
  </div>;
}
export interface ToolRowProps { tool: ToolSegment; connectPrevious?: boolean; connectNext?: boolean }
export function ToolRow({ tool, connectPrevious, connectNext }: ToolRowProps) {
  const state: StepState = tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  const { label, icon } = describeTool(tool);
  const seconds = tool.duration_s != null ? tool.duration_s : tool.completedAt !== undefined ? (tool.completedAt - tool.startedAt) / 1000 : 0;
  // A running tool shows a live timer, so a long command reads as work in progress, not a stuck chat.
  const detail = state === "error" ? "Failed" : state === "done" && seconds >= 1 ? <Elapsed startedAt={tool.startedAt} completedAt={tool.completedAt} seconds={tool.duration_s} />
    : state === "running" && tool.startedAt > 0 ? <Elapsed startedAt={tool.startedAt} /> : undefined;
  const preview = state === "running" ? null : buildPreview(tool);
  // Errors are for the agent. The row shows a red failure marker; the text stays folded away.
  const failure = tool.error ? (typeof tool.error === "string" ? tool.error : tool.message || "Tool failed") : undefined;
  const body = preview || failure ? <>
    {preview && <ResultPreviewView preview={preview} tool={tool} />}
    {failure && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-error)]">{failure.length > 4000 ? `${failure.slice(0, 3999)}…` : failure}</pre>}
  </> : undefined;
  return <TraceStep data-tool-id={tool.id} state={state} icon={icon} label={label} detail={detail} body={body} connectPrevious={connectPrevious} connectNext={connectNext} />;
}
