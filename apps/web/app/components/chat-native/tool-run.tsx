"use client";

import { useEffect, useState } from "react";
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
function Copyable({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  const [copyState, setCopyState] = useState("");
  return <section aria-label={label}>
    <div className="flex items-center gap-2"><strong>{label}</strong><button type="button" className={buttonClass} onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopyState("Copied"); } catch { setCopyState("Copy unavailable"); }
    }}>Copy {label.toLowerCase()}</button><span role="status">{copyState}</span></div>
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words">{text.slice(0, 6000)}{text.length > 6000 ? "\n… Display truncated; copy for full content." : ""}</pre>
  </section>;
}
export interface ToolRowProps { tool: ToolSegment }
export function ToolRow({ tool }: ToolRowProps) {
  const target = toolTarget(tool);
  const result = asRecord(tool.result);
  const files = tool.inline_diff ? parseUnifiedDiff(tool.inline_diff) : [];
  return <details className={cardClass} data-tool-id={tool.id}>
    <summary className="cursor-pointer break-words"><strong>{tool.name}</strong>{target && ` · ${target}`} <span>{tool.status === "running" ? "Running" : tool.status === "error" ? "Error" : "Done"}</span>{" · "}<Elapsed startedAt={tool.startedAt} completedAt={tool.completedAt} seconds={tool.duration_s} /></summary>
    {typeof tool.args.command === "string" && <pre className="overflow-auto">{tool.args.command}</pre>}
    {result.exit_code !== undefined && <p>Exit code: {String(result.exit_code)}</p>}
    <Copyable label="Arguments" value={tool.args} />
    {tool.summary && <p>{tool.summary}</p>}
    {tool.result !== undefined && <Copyable label="Result" value={tool.result} />}
    {tool.error && <p role="alert">{typeof tool.error === "string" ? tool.error : tool.message || "Tool failed"}</p>}
    {tool.inline_diff && <section aria-label="Edit diff">
      <ul>{files.map((file, index) => <li key={`${file.path}-${index}`}>{file.path}: +{file.added} −{file.removed}</li>)}</ul>
      {files.length ? <DiffCard diff={tool.inline_diff} /> : <pre className="overflow-auto">{tool.inline_diff}</pre>}
    </section>}
  </details>;
}
export interface ToolRunProps { tools: readonly ToolSegment[]; live?: boolean }
export function ToolRun({ tools, live = true }: ToolRunProps) {
  const summary = summarizeToolRun(tools, live);
  const liveLine = liveToolPhrase(summary);
  return <details className={cardClass} data-segment="tool-run">
    <summary className="cursor-pointer">{toolRunPhrase(summary)}{liveLine && <span role="status" className="block break-words">{liveLine}</span>}</summary>
    {tools.map(tool => <ToolRow key={tool.id} tool={tool} />)}
  </details>;
}
