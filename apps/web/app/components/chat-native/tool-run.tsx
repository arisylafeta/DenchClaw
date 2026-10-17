"use client";

import { useEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { toolTarget } from "@/lib/hermes-chat/run-summary";

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
  return <span>{Math.max(0, Math.floor(seconds ?? ((completedAt ?? now) - startedAt) / 1000))}s</span>;
}
export type StepState = "running" | "done" | "error";
export const chipClass = "min-w-0 rounded-md bg-[var(--color-surface-hover)] px-2 py-1 font-mono text-[10px] text-[var(--color-text-muted)]";
/** One trace step in the rebattery-platform style: status node on a connector line, label, detail chip. No disclosure. */
export function TraceStep({ state, label, detail, connectPrevious, connectNext, children, ...rest }: {
  state: StepState; label: string; detail?: React.ReactNode; connectPrevious?: boolean; connectNext?: boolean; children?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const Icon = state === "error" ? CircleAlert : state === "done" ? Check : LoaderCircle;
  return <div {...rest} className="relative min-w-0 py-1.5 pl-7">
    {connectPrevious && <span aria-hidden="true" className="absolute top-0 bottom-1/2 left-[7px] w-px bg-[var(--color-border)]" />}
    {connectNext && <span aria-hidden="true" className="absolute top-1/2 -bottom-4 left-[7px] w-px bg-[var(--color-border)]" />}
    <div className="relative flex min-h-6 flex-wrap items-center gap-2.5">
      <span aria-hidden="true" className="absolute -left-7 flex size-3.5 items-center justify-center bg-[var(--color-main-bg)] text-[var(--color-text-muted)]">
        <Icon className={`size-3.5 ${state === "running" ? "animate-spin motion-reduce:animate-none" : ""} ${state === "error" ? "text-[var(--color-error)]" : ""}`} />
      </span>
      {label && <span className="text-[12px] font-medium text-[var(--color-text)]">{label}</span>}
      {detail !== undefined && <span className={chipClass}>{detail}</span>}
    </div>
    {children}
  </div>;
}
export interface ToolRowProps { tool: ToolSegment; connectPrevious?: boolean; connectNext?: boolean }
export function ToolRow({ tool, connectPrevious, connectNext }: ToolRowProps) {
  const target = toolTarget(tool);
  const state: StepState = tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  const label = [tool.name.replace(/_/g, " "), target].filter(Boolean).join(" · ");
  return <TraceStep data-tool-id={tool.id} state={state} label={label} connectPrevious={connectPrevious} connectNext={connectNext}
    detail={<>{state === "running" ? "Running" : state === "error" ? "Error" : "Done"} · <Elapsed startedAt={tool.startedAt} completedAt={tool.completedAt} seconds={tool.duration_s} /></>}>
    {tool.error && <p role="alert" className="mt-1 text-[11px] text-[var(--color-error)]">{typeof tool.error === "string" ? tool.error : tool.message || "Tool failed"}</p>}
  </TraceStep>;
}
export interface ToolRunProps { tools: readonly ToolSegment[]; live?: boolean }
export function ToolRun({ tools }: ToolRunProps) {
  return <div className="w-full min-w-0" data-segment="tool-run">
    {tools.map((tool, index) => <ToolRow key={tool.id} tool={tool} connectPrevious={index > 0} connectNext={index < tools.length - 1} />)}
  </div>;
}
