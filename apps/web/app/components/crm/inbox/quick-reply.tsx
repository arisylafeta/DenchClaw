"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Visual composer at the bottom of the conversation pane. Looks and
 * feels like Gmail's "Reply" affordance — collapsed pill that expands
 * into a textarea — but the Send button is disabled with a tooltip.
 *
 * When two-way Gmail sync arrives, swap the disabled tooltip for an
 * actual `composeReply()` POST and the rest of the UI stays.
 */
export function QuickReply({
  recipientName,
  onExpand,
}: {
  recipientName?: string | null;
  onExpand?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (expanded) {
      textareaRef.current?.focus();
      onExpand?.();
    }
  }, [expanded, onExpand]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors"
        style={{
          background: "var(--color-surface)",
          borderColor: "var(--color-border)",
          color: "var(--color-text-muted)",
          fontFamily: '"Bookerly", Georgia, serif',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-strong)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.borderColor = "var(--color-border)";
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <polyline points="9 17 4 12 9 7" />
          <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
        </svg>
        <span className="text-[14px]">
          Reply{recipientName ? ` to ${recipientName.split(" ")[0]}` : ""}…
        </span>
      </button>
    );
  }

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        background: "var(--color-surface)",
        borderColor: "var(--color-border-strong)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-2"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          To:
        </span>
        <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
          {recipientName ?? "—"}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => {
            setExpanded(false);
            setDraft("");
          }}
          className="text-[12px] rounded px-2 py-1 hover:bg-[var(--color-surface-hover)]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Discard
        </button>
      </div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Type a reply…"
        className="w-full px-4 py-3 outline-none resize-none"
        rows={6}
        style={{
          background: "var(--color-surface)",
          color: "var(--color-text)",
          fontFamily: '"Bookerly", Georgia, "Times New Roman", serif',
          fontSize: 14,
          lineHeight: 1.6,
          border: "none",
        }}
      />
      <div
        className="flex items-center justify-between gap-3 px-4 py-2"
        style={{ borderTop: "1px solid var(--color-border)" }}
      >
        <div className="flex items-center gap-2 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          <span>{draft.length} chars</span>
          {draft.length > 0 && <span>·</span>}
          {draft.length > 0 && <span>Read-only — not actually sent</span>}
        </div>
        <button
          type="button"
          disabled
          title="Two-way Gmail sync is on the roadmap"
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium opacity-60 cursor-not-allowed"
          style={{
            background: "var(--color-accent-fill)",
            color: "var(--color-accent-foreground)",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
