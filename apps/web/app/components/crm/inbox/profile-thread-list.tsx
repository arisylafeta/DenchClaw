"use client";

import { useState } from "react";
import { PersonAvatar } from "../person-avatar";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import { ThreadMessages } from "./thread-messages";

const SENDER_TYPE_COLOR: Record<string, string> = {
  Marketing: "#ef4444",
  Transactional: "#3b82f6",
  Notification: "#f59e0b",
  "Mailing List": "#8b5cf6",
  Automated: "#94a3b8",
};

/**
 * Minimal thread shape consumed by ProfileThreadList. Mirrors a subset
 * of the Inbox API's Thread type — kept narrow so PersonProfile /
 * CompanyProfile APIs don't have to project the full participants array
 * or primary-sender fields up-front (those load lazily inside
 * ThreadMessages on row expand).
 */
export type ProfileThread = {
  id: string;
  subject: string | null;
  snippet?: string | null;
  last_message_at: string | null;
  message_count: number | null;
  gmail_thread_id: string | null;
  /** Optional Sender Type chip. Person-typed threads render with no chip. */
  primary_sender_type?: string | null;
  /** Optional headline sender (avatar / name). */
  primary_sender_name?: string | null;
  primary_sender_email?: string | null;
  primary_sender_avatar_url?: string | null;
};

/**
 * Reusable thread list for PersonProfile / CompanyProfile email tabs.
 *
 * Rows match the Inbox visual language (avatar + Instrument Serif subject
 * + Bookerly snippet + relative time + sender-type chip), without the
 * Inbox-specific affordances (checkbox / star / bulk-select / unread dot
 * — none of which apply in a single-record context).
 *
 * Click anywhere on a row to expand the conversation reader inline. The
 * conversation reader is the SAME `ThreadMessages` component that powers
 * the Inbox's right pane, so message cards / iframe rendering / quick
 * reply behave identically across the app.
 */
export function ProfileThreadList({
  threads,
  onOpenPerson,
  presentation = "default",
}: {
  threads: ReadonlyArray<ProfileThread>;
  onOpenPerson?: (id: string) => void;
  presentation?: "default" | "compact";
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <ul
      className="divide-y"
      style={{
        borderTop: "1px solid var(--color-border)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      {threads.map((thread) => (
        <ProfileThreadListItem
          key={thread.id}
          thread={thread}
          compact={presentation === "compact"}
          expanded={expandedId === thread.id}
          onToggle={() =>
            setExpandedId((prev) => (prev === thread.id ? null : thread.id))
          }
          onOpenPerson={onOpenPerson}
        />
      ))}
    </ul>
  );
}

function ProfileThreadListItem({
  thread,
  expanded,
  onToggle,
  onOpenPerson,
  compact,
}: {
  thread: ProfileThread;
  expanded: boolean;
  onToggle: () => void;
  onOpenPerson?: (id: string) => void;
  compact: boolean;
}) {
  const senderName =
    thread.primary_sender_name ??
    thread.primary_sender_email ??
    null;
  const senderEmail = thread.primary_sender_email ?? null;
  const senderTypeColor =
    thread.primary_sender_type && thread.primary_sender_type !== "Person"
      ? SENDER_TYPE_COLOR[thread.primary_sender_type] ?? "#94a3b8"
      : null;

  const gmailHref = thread.gmail_thread_id
    ? `https://mail.google.com/mail/u/0/#all/${thread.gmail_thread_id}`
    : null;

  return (
    <li>
      {/* Row affordance is a div+role="button" instead of a real <button>
         because the row contains an <a> (the Gmail "open externally"
         link). Interactive content (a, button, etc.) inside a <button>
         is invalid HTML and trips React 19 / Next 15's nesting validator
         ("<button> cannot contain a nested <button>" — same family of
         error). Same approach we use for MessageCard's header. We keep
         keyboard parity with a native button via tabIndex + Enter/Space
         handling and focus-visible ring. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          // Only react to keyboard activation on the row itself; the
          // Gmail link inside has its own keyboard semantics.
          if (e.target !== e.currentTarget) {return;}
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className="group grid w-full items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        style={{
          gridTemplateColumns: "auto minmax(0, 1fr) auto",
          background: expanded ? "var(--color-accent-light)" : "transparent",
          borderLeft: expanded
            ? "2px solid var(--color-accent)"
            : "2px solid transparent",
        }}
        onMouseEnter={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background = "var(--color-surface-hover)";
        }}
        onMouseLeave={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        <PersonAvatar
          src={thread.primary_sender_avatar_url}
          name={senderName ?? thread.subject ?? "Email"}
          seed={senderEmail ?? thread.id}
          size="sm"
        />
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="truncate"
              style={{
                color: "var(--color-text)",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {thread.subject?.trim() || "(no subject)"}
            </span>
            {senderTypeColor && (
              <span
                className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0 text-[10px] uppercase tracking-[0.06em] ${compact ? "rounded-none" : "rounded-full"}`}
                style={{
                  background: compact ? "var(--bt-segment)" : `${senderTypeColor}1f`,
                  color: compact ? "var(--bt-muted)" : senderTypeColor,
                  fontWeight: 600,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 99,
                    background: compact ? "var(--bt-muted)" : senderTypeColor,
                  }}
                />
                {thread.primary_sender_type}
              </span>
            )}
            <span
              className="text-[11px] tabular-nums"
              style={{ color: "var(--color-text-muted)", fontWeight: 400 }}
            >
              {thread.message_count ?? 0}{" "}
              {(thread.message_count ?? 0) === 1 ? "msg" : "msgs"}
            </span>
          </div>
          {(thread.snippet?.trim() || senderName) && (
            <p
              className="mt-0.5 truncate text-[13px]"
              style={{
                color: "var(--color-text-muted)",
                fontFamily: compact ? "inherit" : '"Bookerly", Georgia, "Times New Roman", serif',
              }}
            >
              {senderName && (
                <span style={{ color: "var(--color-text)" }}>{senderName}</span>
              )}
              {senderName && thread.snippet?.trim() && (
                <span> — {thread.snippet.trim()}</span>
              )}
              {!senderName && thread.snippet?.trim() && thread.snippet.trim()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {gmailHref && (
            <a
              href={gmailHref}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open in Gmail"
              className="inline-flex h-7 w-7 items-center justify-center rounded transition-colors opacity-0 group-hover:opacity-100"
              style={{ color: "var(--color-text-muted)" }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  "var(--color-surface)";
                (e.currentTarget as HTMLElement).style.color =
                  "var(--color-text)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
                (e.currentTarget as HTMLElement).style.color =
                  "var(--color-text-muted)";
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
              </svg>
            </a>
          )}
          <span
            className="text-right text-[11px] tabular-nums"
            style={{ color: "var(--color-text-muted)" }}
            title={
              thread.last_message_at
                ? formatAbsoluteDate(thread.last_message_at)
                : undefined
            }
          >
            {thread.last_message_at && formatRelativeDate(thread.last_message_at)}
          </span>
        </div>
      </div>

      {/* Inline conversation reader — animates open via grid-rows trick. */}
      <div
        className="grid transition-[grid-template-rows] duration-[220ms] ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div
              className="px-4 py-4"
              style={{ background: "var(--color-main-bg)" }}
            >
              <ThreadMessages
                threadId={thread.id}
                recipientName={senderName}
                onOpenPerson={onOpenPerson}
                autoScrollOnLoad={false}
              />
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
