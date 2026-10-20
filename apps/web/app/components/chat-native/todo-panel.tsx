"use client";

import { useState } from "react";
import { Check, ChevronRight, X } from "lucide-react";
import type { TodoItem, TodoState, TodoStatus } from "@/lib/hermes-chat/todos";

const TITLE_MAX = 64;

/** Split a task into a short title and optional detail: text before the first ": " when short, else the first clause. */
export function splitTodo(content: string): { title: string; detail: string } {
  const text = content.trim();
  const colon = text.indexOf(": ");
  if (colon > 0 && colon <= TITLE_MAX) return { title: text.slice(0, colon), detail: text.slice(colon + 2).trim() };
  if (text.length <= TITLE_MAX) return { title: text, detail: "" };
  const cut = text.slice(0, TITLE_MAX).replace(/\s+\S*$/, "");
  return { title: `${cut}…`, detail: text };
}

const statusLabel: Record<TodoStatus, string> = { pending: "Pending", in_progress: "In progress", completed: "Done", cancelled: "Cancelled" };

/** Flat status marks: solid shapes, no rings or shadows. Active breathes (opacity only). */
function Node({ status }: { status: TodoStatus }) {
  const base = "relative z-10 mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full";
  if (status === "completed") return <span aria-hidden="true" className={`${base} bg-[var(--color-accent)] text-[var(--color-accent-foreground,#fff)]`}><Check className="todo-check size-2.5" strokeWidth={3.5} /></span>;
  if (status === "cancelled") return <span aria-hidden="true" className={`${base} bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]`}><X className="size-2.5" strokeWidth={3.5} /></span>;
  if (status === "in_progress") return <span aria-hidden="true" className={`${base} todo-node-active bg-[var(--color-accent)]`}><span className="size-1.5 rounded-full bg-[var(--color-surface,#fff)]" /></span>;
  return <span aria-hidden="true" className={`${base} bg-[var(--color-border)]`} />;
}

/** Height-animating disclosure: content stays mounted so it can slide both ways; inert while closed. */
function Collapse({ open, children, className = "" }: { open: boolean; children: React.ReactNode; className?: string }) {
  return <div data-open={open} className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"} ${className}`} aria-hidden={!open} inert={!open}>
    <div className="min-h-0 overflow-hidden">{children}</div>
  </div>;
}

export interface TodoPanelProps { todos: TodoState }

/** Stepper timeline: segmented progress header, status nodes on a rail, one-line titles that open into detail. */
export function TodoPanel({ todos }: TodoPanelProps) {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [hideDone, setHideDone] = useState(false);
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const items = todos.visible.length ? todos.visible : todos.retained;
  if (!items.length) return null;
  // Missing or cyclic parents remain visible as roots, never disappear or recurse forever.
  const roots = items.filter(item => {
    let parent = item.parent;
    const seen = new Set([item.id]);
    while (parent) { if (seen.has(parent)) return true; seen.add(parent); const node = items.find(candidate => candidate.id === parent); if (!node) return true; parent = node.parent; }
    return !item.parent;
  });
  const done = items.filter(item => item.status === "completed").length;
  const open = (item: TodoItem, detail: string) => !!detail && (overrides[item.id] ?? item.status === "in_progress");
  const renderItems = (rows: TodoItem[], ancestors: string[], nested: boolean) => {
    const shown = rows.filter(item => !ancestors.includes(item.id) && !(hideDone && item.status === "completed" && !items.some(child => child.parent === item.id && child.status !== "completed")));
    return <ul className={nested ? "ml-5" : ""}>{shown.map((item, index) => {
      const { title, detail } = splitTodo(item.content);
      const expanded = open(item, detail);
      const last = index === shown.length - 1;
      const muted = item.status === "completed" || item.status === "cancelled";
      return <li key={item.id} data-todo-id={item.id} data-status={item.status} className="relative pl-6">
        {!last && <span aria-hidden="true" className={`absolute left-[7.5px] top-4 bottom-[-2px] w-px ${item.status === "completed" ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"}`} />}
        <span className="absolute left-0 top-1"><Node status={item.status} /></span>
        {detail ? <button type="button" aria-expanded={expanded} onClick={() => setOverrides(prev => ({ ...prev, [item.id]: !expanded }))} className="group/todo flex w-full min-w-0 items-start gap-1 rounded py-0.5 text-left focus-visible:outline-2">
          <span className={`min-w-0 flex-1 truncate font-medium ${muted ? "text-[var(--color-text-muted)] line-through decoration-[var(--color-border)]" : item.status === "in_progress" ? "" : ""}`}>{title}</span>
          <ChevronRight aria-hidden="true" className={`mt-1 size-3 shrink-0 text-[var(--color-text-muted)] opacity-0 transition group-hover/todo:opacity-100 group-focus-visible/todo:opacity-100 ${expanded ? "rotate-90 opacity-100" : ""}`} />
        </button> : <p className={`py-0.5 font-medium ${muted ? "text-[var(--color-text-muted)] line-through decoration-[var(--color-border)]" : item.status === "in_progress" ? "" : ""}`}>{title}</p>}
        <span className="sr-only">{statusLabel[item.status]}</span>
        {detail && <Collapse open={expanded}><p className="pb-1.5 text-[12px] leading-5 text-[var(--color-text-muted)]">{detail}</p></Collapse>}
        {renderItems(items.filter(child => child.parent === item.id), [...ancestors, item.id], true)}
      </li>;
    })}</ul>;
  };
  const active = items.find(item => item.status === "in_progress");
  const expandedPanel = openOverride ?? done < items.length;
  return <section aria-label="Tasks" className="todo-panel px-3 pb-1 pt-2.5 text-[13px] leading-5" data-open={expandedPanel}>
    <header className="flex items-center gap-2">
      <button type="button" aria-expanded={expandedPanel} aria-label="Tasks" onClick={() => setOpenOverride(!expandedPanel)} className="flex min-w-0 items-center gap-2 rounded text-left focus-visible:outline-2">
        <ChevronRight aria-hidden="true" className={`size-3 shrink-0 text-[var(--color-text-muted)] transition-transform motion-reduce:transition-none ${expandedPanel ? "rotate-90" : ""}`} />
        <span className="text-[13px] font-semibold">Tasks</span>
        <span className="font-mono text-[11px] text-[var(--color-text-muted)]">{done}/{items.length} done</span>
        {!expandedPanel && active && <span className="todo-title-active min-w-0 truncate text-[12px]">{splitTodo(active.content).title}</span>}
      </button>
      <div role="progressbar" aria-label="Task progress" aria-valuemin={0} aria-valuemax={items.length} aria-valuenow={done} className="flex min-w-6 flex-1 gap-0.5">
        {items.map(item => <span key={item.id} className={`todo-seg h-1 min-w-1 flex-1 rounded-full ${item.status === "completed" ? "bg-[var(--color-accent)]" : item.status === "in_progress" ? "todo-seg-active bg-[var(--color-accent)]/40" : "bg-[var(--color-border)]"}`} />)}
      </div>
      {expandedPanel && done > 0 && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline-2" onClick={() => setHideDone(value => !value)}>{hideDone ? `Show done (${done})` : "Hide done"}</button>}
    </header>
    <Collapse open={expandedPanel}><div className="max-h-[40dvh] overflow-y-auto pb-1 pr-1 pt-2">{renderItems(roots, [], false)}</div></Collapse>
  </section>;
}
