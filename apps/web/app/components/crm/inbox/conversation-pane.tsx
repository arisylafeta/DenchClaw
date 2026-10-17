"use client";

import { useCallback } from "react";
import { ConversationHeader } from "./conversation-header";
import { ThreadMessages } from "./thread-messages";
import type { Thread } from "./types";
import { pickSenderDisplay } from "./thread-list-row";

/**
 * Right pane (or full-pane on mobile) of the Inbox.
 *
 * This is now a thin shell: sticky `ConversationHeader` on top, the
 * reusable `ThreadMessages` block in the scroller below. The actual
 * thread loading + message rendering + reply composer all live in
 * ThreadMessages so they can be reused in PersonProfile / CompanyProfile
 * email tabs (where rows expand inline) without duplicating the logic.
 *
 * Slide-in animation: when `selectedThread.id` changes, the inner pane
 * fades + translates in from the right ~10px so the user perceives the
 * swap rather than a brittle full re-render.
 */
export function ConversationPane({
  selectedThread,
  starred,
  onToggleStar,
  onOpenPerson,
  onClose,
  crmOnly = true,
}: {
  selectedThread: Thread | null;
  starred: boolean;
  onToggleStar: () => void;
  onOpenPerson?: (id: string) => void;
  /** Single-pane drilldown back-to-list. */
  onClose?: () => void;
  crmOnly?: boolean;
}) {
  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  if (!selectedThread) {
    return (
      <div
        className="flex h-full min-h-0 flex-col items-center justify-center px-8 text-center"
        style={{ background: "var(--color-main-bg)" }}
      >
        <span
          className="text-lg"
          style={{ color: "var(--color-text)", fontWeight: 500 }}
        >
          Pick a thread
        </span>
        <p
          className="mt-1.5 text-[13px] max-w-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          Click any conversation in the list to read it here. Use{" "}
          <kbd className="rounded border px-1.5 py-0.5 text-[11px]">j</kbd> /{" "}
          <kbd className="rounded border px-1.5 py-0.5 text-[11px]">k</kbd> to navigate.
        </p>
      </div>
    );
  }

  // Slide-in animation: bump a key on every thread change so the entire
  // pane re-mounts with the keyframe.
  const animationKey = selectedThread.id;
  const sender = pickSenderDisplay(selectedThread);
  const recipientName = sender.name ?? sender.email;

  return (
    <div
      key={animationKey}
      className="flex h-full min-h-0 flex-col motion-safe:animate-[conv-slide-in_180ms_ease-out]"
      style={{ background: "var(--color-main-bg)" }}
    >
      <style>{`
        @keyframes conv-slide-in {
          from { opacity: 0; transform: translate3d(8px, 0, 0); }
          to { opacity: 1; transform: translate3d(0, 0, 0); }
        }
      `}</style>
      <ConversationHeader
        subject={selectedThread.subject}
        sender={sender}
        isTo={Boolean(selectedThread.is_self)}
        participants={selectedThread.participants}
        gmailThreadId={selectedThread.gmail_thread_id}
        threadId={selectedThread.id}
        starred={starred}
        onToggleStar={onToggleStar}
        onOpenPerson={onOpenPerson}
        onClose={handleClose}
      />
      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
        <ThreadMessages
          threadId={selectedThread.id}
          crmOnly={crmOnly}
          seedParticipants={selectedThread.participants}
          recipientName={recipientName}
          onOpenPerson={onOpenPerson}
          autoScrollOnLoad
        />
      </div>
    </div>
  );
}
