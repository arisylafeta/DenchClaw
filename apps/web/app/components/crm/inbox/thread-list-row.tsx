"use client";

import { useState, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { SenderAvatar } from "../sender-avatar";
import { ShimmerBar, ShimmerText } from "../../ui/shimmer";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import type { Thread } from "./types";

const SENDER_TYPE_COLOR: Record<string, string> = {
  Marketing: "#ef4444",
  Transactional: "#3b82f6",
  Notification: "#f59e0b",
  "Mailing List": "#8b5cf6",
  Automated: "#94a3b8",
};

const ROW_COLUMNS = "16px minmax(110px, 190px) minmax(0, 1fr) auto";

/** Same grid, paddings, 20px lines and divider as a ThreadListRow, with placeholders for the content. */
export function ThreadListRowSkeleton({ index = 0 }: { index?: number }) {
  const widths = ["56%", "70%", "44%", "64%", "50%"];
  return (
    <div aria-hidden className="relative w-full grid items-center gap-x-4 px-4 py-2.5"
      style={{ gridTemplateColumns: ROW_COLUMNS, borderLeft: "2px solid transparent", borderBottom: "1px solid var(--color-border)" }}>
      <span className="inline-block h-4 w-4 rounded border" style={{ borderColor: "var(--color-border-strong)", opacity: 0.5 }} />
      <span className="inline-flex min-w-0 items-center gap-2 border-r pr-4" style={{ borderColor: "var(--color-border)" }}>
        <ShimmerBar w={20} h={20} round /><span className="min-w-0 flex-1"><ShimmerText w="68%" h={11} /></span>
      </span>
      <span className="min-w-0"><ShimmerText w={widths[index % widths.length]} h={11} /></span>
      <span className="inline-flex items-center gap-2"><span className="inline-block h-5 w-5" /><span className="inline-block min-w-[44px]"><ShimmerText w="100%" h={9} /></span></span>
    </div>
  );
}

/** Single-line conversation row: sender | subject — snippet | copy id + time. Checkbox spans the row; hover reveals the id copy. */
export function ThreadListRow({
  thread,
  selected,
  read,
  inBulkSelection,
  onSelect,
  onToggleSelected,
}: {
  thread: Thread;
  selected: boolean;
  read: boolean;
  inBulkSelection: boolean;
  onSelect: () => void;
  onToggleSelected: () => void;
}) {
  const sender = pickSenderDisplay(thread);
  const senderTypeColor = !thread.is_self && thread.primary_sender_type
    ? SENDER_TYPE_COLOR[thread.primary_sender_type] ?? null : null;
  const [copied, setCopied] = useState(false);
  const stop = (e: MouseEvent) => e.stopPropagation();
  const copyId = (e: MouseEvent) => {
    stop(e);
    void navigator.clipboard?.writeText(thread.id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      data-thread-id={thread.id}
      data-thread-row="true"
      className="group relative w-full grid items-center gap-x-4 px-4 py-2.5 text-left transition-colors"
      style={{
        gridTemplateColumns: ROW_COLUMNS,
        background: selected
          ? "color-mix(in oklab, var(--color-text) 4%, transparent)"
          : inBulkSelection
            ? "color-mix(in oklab, var(--color-accent) 5%, transparent)"
            : "transparent",
        borderLeft: selected ? "2px solid var(--color-accent)" : "2px solid transparent",
        borderBottom: "1px solid var(--color-border)",
      }}
      onMouseEnter={(e) => {
        if (selected) {return;}
        (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
      }}
      onMouseLeave={(e) => {
        if (selected) {return;}
        (e.currentTarget as HTMLElement).style.background = inBulkSelection
          ? "color-mix(in oklab, var(--color-accent) 5%, transparent)"
          : "transparent";
      }}
    >
      {/* Checkbox */}
      <span
        role="checkbox"
        aria-checked={inBulkSelection}
        tabIndex={-1}
        onClick={(e) => {
          stop(e);
          onToggleSelected();
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggleSelected();
          }
        }}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border cursor-pointer"
        style={{
          background: inBulkSelection ? "var(--color-accent-fill)" : "transparent",
          borderColor: inBulkSelection ? "var(--color-accent)" : "var(--color-border-strong)",
        }}
      >
        {inBulkSelection && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-foreground)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>

      {/* Avatar + sender: the darkest text on the row */}
      <span data-mail-line="sender" className="inline-flex items-center gap-2 min-w-0 border-r pr-4" style={{ borderColor: "var(--color-border)" }}>
        <SenderAvatar
          avatarUrl={sender.avatar_url}
          name={sender.name}
          email={sender.email}
          seed={sender.email ?? thread.id}
          senderType={thread.primary_sender_type}
          size="sm"
          className="!h-5 !w-5 !text-[9px] shrink-0"
        />
        <span
          className="truncate text-[13px] leading-5"
          style={{
            color: "var(--color-text)",
            fontWeight: read ? 400 : 600,
          }}
          title={sender.email ?? sender.name ?? undefined}
        >
          {thread.is_self && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>To: </span>}
          {sender.name ?? sender.email ?? "Unknown"}
          {(thread.message_count ?? 0) > 1 && (
            <span
              className="ml-1 text-[11px] tabular-nums"
              style={{ color: "var(--color-text-muted)", fontWeight: 400 }}
            >
              ({thread.message_count})
            </span>
          )}
        </span>
      </span>

      {/* Subject (mid shade) + snippet (muted) */}
      <span data-mail-line="subject" className="min-w-0 flex items-center gap-2 overflow-hidden whitespace-nowrap">
        {!read && (
          <span
            aria-hidden
            className="shrink-0"
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              background: "var(--color-accent)",
            }}
          />
        )}
        <span
          className="max-w-[60%] shrink-0 truncate text-[13px] leading-5"
          style={{
            color: "color-mix(in oklab, var(--color-text) 85%, var(--color-text-muted))",
            fontWeight: read ? 400 : 600,
          }}
        >
          {thread.subject?.trim() || "(no subject)"}
        </span>
        {senderTypeColor && (
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[10px] uppercase tracking-[0.06em]"
            style={{
              background: `${senderTypeColor}1f`,
              color: senderTypeColor,
              fontWeight: 600,
            }}
          >
            <span
              aria-hidden
              style={{ width: 5, height: 5, borderRadius: 99, background: senderTypeColor }}
            />
            {thread.primary_sender_type}
          </span>
        )}
        {thread.snippet?.trim() && (
          <span
            className="min-w-0 flex-1 truncate text-[13px] leading-5"
            style={{
              color: "var(--color-text-muted)",
            }}
          >
            — {thread.snippet.trim()}
          </span>
        )}
      </span>

      {/* Copy id (hover) + time */}
      <span className="inline-flex items-center gap-2 shrink-0">
        <span
          role="button"
          tabIndex={-1}
          onClick={copyId}
          title={copied ? "Copied" : "Copy thread id"}
          aria-label="Copy thread id"
          className={`inline-flex h-5 w-5 items-center justify-center rounded cursor-pointer transition-opacity hover:bg-[var(--color-surface-hover)] ${copied ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          style={{ color: "var(--color-text-muted)" }}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
        </span>
        <span
          className="min-w-[44px] text-right text-[11px] leading-5 tabular-nums"
          style={{ color: "var(--color-text-muted)" }}
          title={thread.last_message_at ? formatAbsoluteDate(thread.last_message_at) : undefined}
        >
          {thread.last_message_at && formatRelativeDate(thread.last_message_at)}
        </span>
      </span>
    </button>
  );
}

export function pickSenderDisplay(thread: Thread): {
  name: string | null;
  email: string | null;
  avatar_url: string | null;
} {
  const primaryParticipant = thread.primary_sender_id
    ? thread.participants.find((x) => x.id === thread.primary_sender_id)
    : undefined;
  if (thread.counterparty) {
    const participant = thread.participants.find((person) => person.email?.toLowerCase() === thread.counterparty?.email?.toLowerCase());
    const selfCounterparty = participant?.is_self || thread.counterparty.email?.toLowerCase().endsWith("@rebattery.io");
    const external = selfCounterparty ? thread.participants.find((person) => person.email && !person.is_self && !person.email.toLowerCase().endsWith("@rebattery.io")) : undefined;
    if (external) {return { name: external.name ?? external.email, email: external.email, avatar_url: external.avatar_url };}
    return { ...thread.counterparty, name: selfCounterparty ? thread.counterparty.email : thread.counterparty.name, avatar_url: participant?.avatar_url ?? null };
  }
  if (thread.is_self || primaryParticipant?.is_self) {
    const recipient = thread.participants.find((person) => !person.is_self && !person.email?.toLowerCase().endsWith("@rebattery.io"))
      ?? thread.participants.find((person) => person.id !== thread.primary_sender_id);
    return { name: recipient?.name ?? recipient?.email ?? "Unknown recipient", email: recipient?.email ?? null, avatar_url: recipient?.avatar_url ?? null };
  }

  if (thread.primary_sender_name || thread.primary_sender_email) {
    return {
      name: thread.primary_sender_name ?? thread.primary_sender_email ?? null,
      email: thread.primary_sender_email,
      avatar_url: primaryParticipant?.avatar_url ?? null,
    };
  }
  return { name: "Unknown sender", email: null, avatar_url: null };
}
