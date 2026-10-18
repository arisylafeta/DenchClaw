"use client";

import { useState } from "react";
import type { ToolSegment } from "@/lib/hermes-chat/reducer";
import { DiffCard } from "../diff-viewer";
import { previewCopyText, type ResultPreview } from "./preview";

const block = "max-h-72 overflow-auto rounded-md bg-[var(--color-surface-hover)] p-2 font-mono text-[11px] leading-5";
function CopyButton({ tool }: { tool: Pick<ToolSegment, "result" | "inline_diff"> }) {
  const [state, setState] = useState("");
  return <button type="button" className="rounded px-1 text-[10px] text-[var(--color-text-muted)] hover:underline focus-visible:outline-2" onClick={async () => {
    try { await navigator.clipboard.writeText(previewCopyText(tool).slice(0, 200_000)); setState("Copied"); } catch { setState("Copy unavailable"); }
  }}>{state || "Copy full result"}</button>;
}
/** What a tool returned, in a form that fits the tool: code lines, a list of hits, a table or a diff. */
export function ResultPreviewView({ preview, tool }: { preview: ResultPreview; tool: Pick<ToolSegment, "result" | "inline_diff"> }) {
  return <div className="min-w-0 space-y-1 text-[11px] leading-5" data-preview={preview.kind}>
    {preview.kind === "diff" && <DiffCard diff={preview.diff} />}
    {preview.kind === "code" && <pre className={block}>{preview.lines.map((line, index) => <div key={index} className="whitespace-pre-wrap break-words">{line || " "}</div>)}</pre>}
    {preview.kind === "text" && <p className="whitespace-pre-wrap break-words text-[var(--color-text-muted)]">{preview.text}</p>}
    {preview.kind === "list" && <ul className="space-y-1">{preview.items.map((item, index) => <li key={index} className="min-w-0">
      {item.href ? <a href={item.href} target="_blank" rel="noreferrer noopener" className="block truncate font-medium underline-offset-2 hover:underline">{item.title}</a> : <span className="block truncate font-medium">{item.title}</span>}
      {item.sub && <span className="block truncate text-[var(--color-text-muted)]">{item.sub}</span>}
    </li>)}</ul>}
    {preview.kind === "table" && <div className="overflow-auto rounded-md border border-[var(--color-border)]"><table className="w-full text-left">
      <thead><tr>{preview.columns.map(column => <th key={column} className="px-2 py-1 font-semibold text-[var(--color-text-muted)]">{column}</th>)}</tr></thead>
      <tbody>{preview.rows.map((row, index) => <tr key={index} className="border-t border-[var(--color-border)]">{row.map((value, column) => <td key={column} className="max-w-[16rem] truncate px-2 py-1">{value}</td>)}</tr>)}</tbody>
    </table></div>}
    <div className="flex items-center gap-2 text-[10px] text-[var(--color-text-muted)]">{preview.note && <span>{preview.note}</span>}<CopyButton tool={tool} /></div>
  </div>;
}
