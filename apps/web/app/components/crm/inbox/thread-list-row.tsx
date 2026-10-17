"use client";

import type { MouseEvent } from "react";
import { SenderAvatar } from "../sender-avatar";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import type { Thread } from "./types";

const SENDER_TYPE_COLOR: Record<string, string> = {
  Marketing: "#ef4444",
  Transactional: "#3b82f6",
  Notification: "#f59e0b",
  "Mailing List": "#8b5cf6",
  Automated: "#94a3b8",
};

/** Compact two-line conversation row. Selection controls span both lines. */
export function ThreadListRow({
  thread,
  selected,
  read,
  starred,
  inBulkSelection,
  onSelect,
  onToggleSelected,
  onToggleStarred,
}: {
  thread: Thread;
  selected: boolean;
  read: boolean;
  starred: boolean;
  inBulkSelection: boolean;
  onSelect: () => void;
  onToggleSelected: () => void;
  onToggleStarred: () => void;
}) {
  const sender = pickSenderDisplay(thread);
  const senderTypeColor = !thread.is_self && thread.primary_sender_type
    ? SENDER_TYPE_COLOR[thread.primary_sender_type] ?? null : null;

  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <button
      type="button"
      onClick={onSelect}
      data-thread-id={thread.id}
      data-thread-row="true"
      className="group relative w-full grid items-center gap-x-2 gap-y-1 px-4 py-2.5 text-left transition-colors"
      style={{
        gridTemplateColumns: "20px 16px minmax(0, 1fr) auto",
        gridTemplateRows: "18px 20px",
        background: selected
          ? "var(--color-accent-light)"
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
        className="row-span-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border cursor-pointer"
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

      {/* Star */}
      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          stop(e);
          onToggleStarred();
        }}
        title={starred ? "Unstar" : "Star"}
        className="row-span-2 inline-flex h-4 w-4 shrink-0 items-center justify-center cursor-pointer"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill={starred ? "#f59e0b" : "none"}
          stroke={starred ? "#f59e0b" : "var(--color-text-muted)"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
        </svg>
      </span>

      {/* Avatar + sender */}
      <span data-mail-line="sender" className="col-start-3 row-start-1 inline-flex items-center gap-1.5 min-w-0">
        <SenderAvatar
          avatarUrl={sender.avatar_url}
          name={sender.name}
          email={sender.email}
          seed={sender.email ?? thread.id}
          senderType={thread.primary_sender_type}
          size="sm"
          className="!h-4 !w-4 !text-[9px]"
        />
        <span
          className="truncate text-[13px]"
          style={{
            color: "var(--color-text)",
            fontWeight: read ? 400 : 600,
          }}
          title={sender.email ?? sender.name ?? undefined}
        >
          {thread.is_self && <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>To: </span>}
          {sender.name ?? sender.email ?? "Unknown"}
          {thread.participants.length > 1 && (
            <span
              className="ml-1 text-[11px] tabular-nums"
              style={{ color: "var(--color-text-muted)", fontWeight: 400 }}
            >
              ({thread.participants.length})
            </span>
          )}
        </span>
      </span>

      {/* Subject + snippet */}
      <span data-mail-line="subject" className="col-start-3 col-span-2 row-start-2 min-w-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
        {!read && (
          <span
            aria-hidden
            className="shrink-0"
            style={{
              width: 6,
              height: 6,
              borderRadius: 99,
              background: "var(--color-accent-fill)",
            }}
          />
        )}
        <span
          className="max-w-[70%] shrink-0 truncate text-[14px]"
          style={{
            color: "var(--color-text)",
            fontSize: 14,
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
            className="min-w-0 flex-1 truncate text-[13px]"
            style={{
              color: "var(--color-text-muted)",
            }}
          >
            — {thread.snippet.trim()}
          </span>
        )}
      </span>

      {/* Time */}
      <span
        className="col-start-4 row-start-1 text-right text-[11px] tabular-nums shrink-0"
        style={{ color: "var(--color-text-muted)" }}
        title={thread.last_message_at ? formatAbsoluteDate(thread.last_message_at) : undefined}
      >
        {thread.last_message_at && formatRelativeDate(thread.last_message_at)}
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
    return { ...thread.counterparty, avatar_url: participant?.avatar_url ?? null };
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
