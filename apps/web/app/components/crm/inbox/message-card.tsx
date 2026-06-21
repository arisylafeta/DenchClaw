"use client";

import { useEffect, useRef, useState } from "react";
import { SenderAvatar } from "../sender-avatar";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import { MessageBody } from "./message-body";
import { AttachmentStrip } from "./attachment-strip";
import type { Message } from "./types";
import type { Participant } from "./participant-chips";

/**
 * Single email message in a thread. Latest message expands by default,
 * older messages collapse to a one-line summary that expands on click.
 *
 * Mirrors Gmail's stacked-card pattern: collapsed shows sender + snippet
 * + time on a single line; expanded shows the full message-card with
 * sender header, body, attachments.
 */
export function MessageCard({
  message,
  people,
  defaultExpanded,
  onOpenPerson,
}: {
  message: Message;
  people: Map<string, Participant>;
  defaultExpanded: boolean;
  onOpenPerson?: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Scroll the latest expanded message into view on mount.
  useEffect(() => {
    if (defaultExpanded) {
      contentRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [defaultExpanded]);

  const sender = message.from_person_id ? people.get(message.from_person_id) : null;
  const senderName = sender?.name ?? message.from_name ?? message.from_email ?? "Unknown sender";
  const senderEmail = sender?.email ?? message.from_email ?? null;
  const tos = message.to_person_ids
    .map((id) => people.get(id))
    .filter((p): p is Participant => Boolean(p));
  const ccs = message.cc_person_ids
    .map((id) => people.get(id))
    .filter((p): p is Participant => Boolean(p));

  return (
    <article
      ref={contentRef}
      className="rounded-2xl border overflow-hidden"
      style={{
        background: "var(--color-surface)",
        borderColor: expanded ? "var(--color-border-strong)" : "var(--color-border)",
        boxShadow: expanded ? "var(--shadow-md)" : "none",
        transition: "border-color 160ms ease-out, box-shadow 160ms ease-out",
      }}
    >
      {/* Header row — always visible. Rendered as a div+role="button"
         instead of a real <button> because the expanded state shows
         clickable To/Cc person chips inside this region, and nesting
         buttons is invalid HTML (causes a hydration error in React 19
         / Next 15). We keep keyboard parity with native button via
         tabIndex + Enter/Space handling. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="w-full flex items-start gap-3 px-4 py-3 text-left cursor-pointer transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <SenderAvatar
          avatarUrl={sender?.avatar_url}
          name={senderName}
          email={senderEmail}
          seed={senderEmail ?? message.id}
          senderType={message.sender_type ?? null}
          size="md"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className="text-[14px] font-semibold truncate"
              style={{ color: "var(--color-text)" }}
            >
              {senderName}
            </span>
            {senderEmail && senderEmail !== senderName && (
              <span
                className="text-[12px] truncate"
                style={{ color: "var(--color-text-muted)" }}
              >
                &lt;{senderEmail}&gt;
              </span>
            )}
            {message.sender_type && message.sender_type !== "Person" && (
              <SenderTypeChip kind={message.sender_type} />
            )}
            <span className="flex-1" />
            <span
              className="text-[12px] tabular-nums shrink-0"
              style={{ color: "var(--color-text-muted)" }}
              title={message.sent_at ? formatAbsoluteDate(message.sent_at) : undefined}
            >
              {message.sent_at && formatRelativeDate(message.sent_at)}
            </span>
          </div>
          {!expanded && (
            <p
              className="mt-0.5 truncate text-[13px]"
              style={{
                color: "var(--color-text-muted)",
                fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
              }}
            >
              {message.preview?.trim() || "(empty body)"}
            </p>
          )}
          {expanded && (tos.length > 0 || ccs.length > 0) && (
            <p
              className="mt-1 text-[12px] truncate"
              style={{ color: "var(--color-text-muted)" }}
            >
              <span style={{ color: "var(--color-text-muted)" }}>To:</span>{" "}
              {tos.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ", "}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenPerson?.(p.id);
                    }}
                    className="hover:underline"
                    style={{ color: "var(--color-text)" }}
                  >
                    {p.name?.trim() || p.email}
                  </button>
                </span>
              ))}
              {ccs.length > 0 && (
                <>
                  <span className="mx-2">·</span>
                  <span style={{ color: "var(--color-text-muted)" }}>Cc:</span>{" "}
                  {ccs.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && ", "}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPerson?.(p.id);
                        }}
                        className="hover:underline"
                        style={{ color: "var(--color-text)" }}
                      >
                        {p.name?.trim() || p.email}
                      </button>
                    </span>
                  ))}
                </>
              )}
            </p>
          )}
        </div>
      </div>

      {/* Body — animates open via grid-rows trick (height-without-jank) */}
      <div
        className="grid transition-[grid-template-rows] duration-[220ms] ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <div className="px-4 pb-4">
            <MessageBody body={message.body} preview={message.preview} />
            {message.has_attachments && <AttachmentStrip />}
          </div>
        </div>
      </div>
    </article>
  );
}

const SENDER_TYPE_COLOR: Record<string, string> = {
  Marketing: "#ef4444",
  Transactional: "#3b82f6",
  Notification: "#f59e0b",
  "Mailing List": "#8b5cf6",
  Automated: "#94a3b8",
};

function SenderTypeChip({ kind }: { kind: string }) {
  const color = SENDER_TYPE_COLOR[kind] ?? "#94a3b8";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0 text-[10px] uppercase tracking-[0.06em]"
      style={{
        background: `${color}1f`,
        color,
        fontWeight: 600,
      }}
    >
      <span
        aria-hidden
        style={{ width: 5, height: 5, borderRadius: 99, background: color }}
      />
      {kind}
    </span>
  );
}
