"use client";

import { useEffect, useState } from "react";
import { Check, ChevronRight, CircleAlert, LoaderCircle } from "lucide-react";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { asRecord } from "@/lib/hermes-chat/events";
import { parseUnifiedDiff, summarizeToolRun, toolTarget } from "@/lib/hermes-chat/run-summary";
import { DiffCard } from "../diff-viewer";
import { liveToolPhrase, toolRunPhrase } from "./phrases";

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
/** Timeline node drawn on the connector line, shared by tool steps and reasoning. */
export type StepState = "running" | "done" | "error";
export function StepNode({ state }: { state: StepState }) {
  const Icon = state === "error" ? CircleAlert : state === "done" ? Check : LoaderCircle;
  return <span aria-hidden="true" className="absolute -left-[27px] top-[7px] flex size-3.5 items-center justify-center bg-[var(--color-main-bg)] text-[var(--color-text-muted)]">
    <Icon className={`size-3.5 ${state === "running" ? "animate-spin motion-reduce:animate-none" : ""} ${state === "error" ? "text-[var(--color-error)]" : ""}`} />
  </span>;
}
/** Open while live, fold away when the work finishes; a manual toggle always wins. */
export function useLiveDisclosure(live: boolean) {
  const [open, setOpen] = useState(live);
  const [manual, setManual] = useState(false);
  useEffect(() => { if (!manual) setOpen(live); }, [live, manual]);
  return { open, onToggle: (event: { currentTarget: { open: boolean } }) => { if (event.currentTarget.open !== open) { setManual(true); setOpen(event.currentTarget.open); } } };
}
export const stepSummaryClass = "flex cursor-pointer list-none items-center gap-2 py-1 text-[12px] [&::-webkit-details-marker]:hidden";
export const chipClass = "min-w-0 rounded-md bg-[var(--color-surface-hover)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-text-muted)]";
export const treeClass = "relative ml-[7px] w-full min-w-0 space-y-0.5 border-l border-[var(--color-border)] pl-5";
function Chevron() { return <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-[var(--color-text-muted)] transition-transform group-open/step:rotate-90" />; }
function Copyable({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  const [copyState, setCopyState] = useState("");
  return <section aria-label={label} className="min-w-0">
    <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]"><strong className="font-semibold uppercase tracking-wide">{label}</strong><button type="button" className="rounded px-1 underline-offset-2 hover:underline focus-visible:outline-2" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopyState("Copied"); } catch { setCopyState("Copy unavailable"); }
    }}>Copy {label.toLowerCase()}</button><span role="status">{copyState}</span></div>
    <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-hover)] p-2 font-mono text-[11px] leading-5">{text.slice(0, 6000)}{text.length > 6000 ? "\n… Display truncated; copy for full content." : ""}</pre>
  </section>;
}
export interface ToolRowProps { tool: ToolSegment }
export function ToolRow({ tool }: ToolRowProps) {
  const target = toolTarget(tool);
  const result = asRecord(tool.result);
  const files = tool.inline_diff ? parseUnifiedDiff(tool.inline_diff) : [];
  const state: StepState = tool.status === "running" ? "running" : tool.status === "error" ? "error" : "done";
  return <li className="relative min-w-0">
    <StepNode state={state} />
    <details className="group/step" data-tool-id={tool.id}>
      <summary className={stepSummaryClass}><Chevron /><strong className="font-medium">{tool.name}</strong>{target && <span className="min-w-0 truncate text-[var(--color-text-muted)]">{target}</span>}<span className={chipClass}>{tool.status === "running" ? "Running" : tool.status === "error" ? "Error" : "Done"} · <Elapsed startedAt={tool.startedAt} completedAt={tool.completedAt} seconds={tool.duration_s} /></span></summary>
      <div className="space-y-2 pb-2 pl-5 text-[11px] leading-5">
        {typeof tool.args.command === "string" && <pre className="overflow-auto rounded-md bg-[var(--color-surface-hover)] p-2 font-mono">{tool.args.command}</pre>}
        {result.exit_code !== undefined && <p className="text-[var(--color-text-muted)]">Exit code: {String(result.exit_code)}</p>}
        <Copyable label="Arguments" value={tool.args} />
        {tool.summary && <p>{tool.summary}</p>}
        {tool.result !== undefined && <Copyable label="Result" value={tool.result} />}
        {tool.error && <p role="alert" className="text-[var(--color-error)]">{typeof tool.error === "string" ? tool.error : tool.message || "Tool failed"}</p>}
        {tool.inline_diff && <section aria-label="Edit diff" className="min-w-0 space-y-1">
          <ul className="text-[var(--color-text-muted)]">{files.map((file, index) => <li key={`${file.path}-${index}`}>{file.path}: +{file.added} −{file.removed}</li>)}</ul>
          {files.length ? <DiffCard diff={tool.inline_diff} /> : <pre className="overflow-auto font-mono">{tool.inline_diff}</pre>}
        </section>}
      </div>
    </details>
  </li>;
}
export interface ToolRunProps { tools: readonly ToolSegment[]; live?: boolean }
export function ToolRun({ tools, live = true }: ToolRunProps) {
  const summary = summarizeToolRun(tools, live);
  const liveLine = liveToolPhrase(summary);
  const disclosure = useLiveDisclosure(live && tools.some(tool => tool.status === "running"));
  return <details className="group/step w-full min-w-0" data-segment="tool-run" open={disclosure.open} onToggle={disclosure.onToggle}>
    <summary className={stepSummaryClass}><Chevron /><span className="font-medium">{toolRunPhrase(summary)}</span>{liveLine && <span role="status" className="min-w-0 truncate text-[var(--color-text-muted)]">{liveLine}</span>}</summary>
    <ol className={treeClass}>{tools.map(tool => <ToolRow key={tool.id} tool={tool} />)}</ol>
  </details>;
}
