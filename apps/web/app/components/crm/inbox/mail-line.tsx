"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { SenderAvatar } from "../sender-avatar";
import { ShimmerBar, ShimmerText } from "../../ui/shimmer";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";

/**
 * Gmail-style single line shared by Sent and Drafts (Conversations uses ThreadListRow with the same layout):
 * avatar + sender | subject — snippet | tag, copy id (hover), time. The tag sits outside the clipped text
 * so a popover opened from it floats above the rows below.
 */
const LINE_CLASS = "group relative grid w-full items-center gap-x-4 px-4 py-2.5 text-left transition-colors";
const LINE_COLUMNS = "minmax(96px, 170px) minmax(0, 1fr) auto";
const LINE_BORDER = "1px solid var(--color-border)";

/** Same grid, paddings, 20px lines and divider as a MailLine, with placeholders for the content. */
export function MailLineSkeleton({ index = 0 }: { index?: number }) {
  const widths = ["58%", "72%", "46%", "66%", "52%"];
  return <div aria-hidden className={LINE_CLASS} style={{ gridTemplateColumns: LINE_COLUMNS, borderBottom: LINE_BORDER }}>
    <span className="inline-flex min-w-0 items-center gap-2 border-r pr-4" style={{ borderColor: "var(--color-border)" }}>
      <ShimmerBar w={20} h={20} round /><span className="min-w-0 flex-1"><ShimmerText w="70%" h={11} /></span>
    </span>
    <span className="min-w-0"><ShimmerText w={widths[index % widths.length]} h={11} /></span>
    <span className="inline-flex items-center gap-2"><span className="inline-block h-5 w-5" /><span className="inline-block min-w-[44px]"><ShimmerText w="100%" h={9} /></span></span>
  </div>;
}

export function MailLine({ id, prefix, name, nameTitle, email, subject, snippet, at, tag, onOpen, label, selected }: {
  id: string; prefix?: string; name: string | null; nameTitle?: string; email: string | null; subject: string; snippet?: string | null; at: string | null;
  tag?: ReactNode; onOpen?: () => void; label?: string; selected?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (event: MouseEvent) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(id).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const Root = onOpen ? "button" : "div";
  return <Root {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": label, "aria-current": selected ? "true" : undefined } : {})} data-mail-row={id}
    className={`${LINE_CLASS} hover:bg-[var(--color-surface-hover)]`}
    style={{ gridTemplateColumns: LINE_COLUMNS, borderBottom: LINE_BORDER, background: selected ? "color-mix(in srgb, var(--color-accent-fill) 14%, transparent)" : undefined, boxShadow: selected ? "inset 3px 0 0 var(--color-accent)" : undefined }}>
    <span data-mail-line="sender" className="inline-flex min-w-0 items-center gap-2 border-r pr-4" style={{ borderColor: "var(--color-border)" }}>
      <SenderAvatar name={name} email={email} seed={email ?? id} size="sm" className="!h-5 !w-5 !text-[9px] shrink-0" />
      <span className="truncate text-[13px] leading-5" style={{ color: "var(--color-text)" }} title={nameTitle ?? email ?? name ?? undefined}>
        {prefix && <span style={{ color: "var(--color-text-muted)" }}>{prefix} </span>}{name ?? email ?? "Unknown"}
      </span>
    </span>
    <span data-mail-line="subject" className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
      <span className="max-w-[60%] shrink-0 truncate text-[13px] leading-5" style={{ color: "color-mix(in oklab, var(--color-text) 85%, var(--color-text-muted))" }}>{subject}</span>
      {snippet?.trim() && <span className="min-w-0 flex-1 truncate text-[13px] leading-5" style={{ color: "var(--color-text-muted)" }}>— {snippet.trim()}</span>}
    </span>
    <span className="inline-flex shrink-0 items-center gap-2">
      {tag}
      <span role="button" tabIndex={-1} onClick={copy} aria-label="Copy id" title={copied ? "Copied" : "Copy id"}
        className={`inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded transition-opacity hover:bg-[var(--color-surface-hover)] ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`} style={{ color: "var(--color-text-muted)" }}>
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </span>
      <span className="min-w-[44px] text-right text-[11px] leading-5 tabular-nums" style={{ color: "var(--color-text-muted)" }} title={at ? formatAbsoluteDate(at) : undefined}>{at && formatRelativeDate(at)}</span>
    </span>
  </Root>;
}
