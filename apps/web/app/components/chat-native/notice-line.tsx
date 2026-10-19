"use client";

import { useState } from "react";
import { Bell, ChevronRight, CircleCheck, Compass, Repeat, Shuffle, SquareTerminal } from "lucide-react";
import type { Notice, NoticeKind } from "@/lib/hermes-chat/notice";

const ICON = { delegation: CircleCheck, notification: Bell, resume: Repeat, steer: Compass, model: Shuffle, process: SquareTerminal } as const satisfies Record<NoticeKind, unknown>;
/** A system event Hermes stored as a user row: one muted line, details on demand. */
export function NoticeLine({ notice, onCancel }: { notice: Notice; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[notice.kind];
  const hasDetails = Boolean(notice.details) && notice.kind !== "model";
  return <div data-notice={notice.kind} role={notice.tone === "error" ? "alert" : "status"} className={`py-1 text-[12px] ${notice.tone === "error" ? "text-[var(--color-error)]" : "text-[var(--color-text-muted)]"}`}>
    <button type="button" disabled={!hasDetails} aria-expanded={hasDetails ? open : undefined} onClick={() => setOpen(!open)} className="flex min-w-0 max-w-full items-center gap-2 text-left disabled:cursor-default">
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{notice.text}</span>
      {hasDetails && <ChevronRight aria-hidden="true" className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />}
    </button>
    {notice.pending && onCancel && <button type="button" aria-label="Cancel queued command" onClick={onCancel} className="mt-1 rounded px-2 py-1 underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]">Cancel</button>}
    {open && hasDetails && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-hover)] p-2 font-mono text-[11px] leading-5">{notice.details}</pre>}
  </div>;
}
