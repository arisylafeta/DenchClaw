"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { SenderAvatar } from "../sender-avatar";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";

/**
 * Gmail-style single line shared by Sent and Drafts (Conversations uses ThreadListRow with the same layout):
 * avatar + sender | subject — snippet | tag, copy id (hover), time. The tag sits outside the clipped text
 * so a popover opened from it floats above the rows below.
 */
export function MailLine({ id, prefix, name, nameTitle, email, subject, snippet, at, tag, onOpen, label }: {
  id: string; prefix?: string; name: string | null; nameTitle?: string; email: string | null; subject: string; snippet?: string | null; at: string | null;
  tag?: ReactNode; onOpen?: () => void; label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (event: MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const Root = onOpen ? "button" : "div";
  return <Root {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": label } : {})} data-mail-row={id}
    className="group relative grid w-full items-center gap-x-4 px-4 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
    style={{ gridTemplateColumns: "minmax(110px, 190px) minmax(0, 1fr) auto", borderBottom: "1px solid var(--color-border)" }}>
    <span data-mail-line="sender" className="inline-flex min-w-0 items-center gap-2 border-r pr-4" style={{ borderColor: "var(--color-border)" }}>
      <SenderAvatar name={name} email={email} seed={email ?? id} size="sm" className="!h-5 !w-5 !text-[9px] shrink-0" />
      <span className="truncate text-[13px]" style={{ color: "var(--color-text)" }} title={nameTitle ?? email ?? name ?? undefined}>
        {prefix && <span style={{ color: "var(--color-text-muted)" }}>{prefix} </span>}{name ?? email ?? "Unknown"}
      </span>
    </span>
    <span data-mail-line="subject" className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
      <span className="max-w-[60%] shrink-0 truncate text-[13px]" style={{ color: "color-mix(in oklab, var(--color-text) 85%, var(--color-text-muted))" }}>{subject}</span>
      {snippet?.trim() && <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--color-text-muted)" }}>— {snippet.trim()}</span>}
    </span>
    <span className="inline-flex shrink-0 items-center gap-2">
      {tag}
      <span role="button" tabIndex={-1} onClick={copy} aria-label="Copy id" title={copied ? "Copied" : "Copy id"}
        className={`inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded transition-opacity hover:bg-[var(--color-surface-hover)] ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} style={{ color: "var(--color-text-muted)" }}>
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </span>
      <span className="min-w-[44px] text-right text-[11px] tabular-nums" style={{ color: "var(--color-text-muted)" }} title={at ? formatAbsoluteDate(at) : undefined}>{at && formatRelativeDate(at)}</span>
    </span>
  </Root>;
}
