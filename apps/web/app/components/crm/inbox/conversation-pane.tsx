"use client";

import { useCallback, useState } from "react";
import { ConversationHeader } from "./conversation-header";
import { ThreadMessages, type ThreadDetail } from "./thread-messages";
import type { Thread } from "./types";
import { pickSenderDisplay } from "./thread-list-row";
import type { Participant } from "./participant-chips";
import styles from "./mail.module.css";

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
  const [metadata, setMetadata] = useState<{ threadId: string; count: number; first: string | null; last: string | null; people: Participant[] } | null>(null);
  const handleLoaded = useCallback((detail: ThreadDetail) => {
    const dates = detail.messages.map((message) => message.sent_at).filter((date): date is string => Boolean(date));
    setMetadata({ threadId: detail.thread_id, count: detail.messages.length, first: dates[0] ?? null, last: dates.at(-1) ?? null, people: detail.people });
  }, []);
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
  const currentMeta = metadata?.threadId === selectedThread.id ? metadata : null;
  const participants = [...(currentMeta?.people ?? []), ...selectedThread.participants];
  if (sender.email && !participants.some((person) => person.email?.toLowerCase() === sender.email?.toLowerCase())) {
    participants.push({ id: sender.email, name: sender.name, email: sender.email, avatar_url: sender.avatar_url });
  }

  return (
    <div
      key={animationKey}
      className={`bulk-trades ${styles.thread} flex h-full min-h-0 flex-col motion-safe:animate-[conv-slide-in_180ms_ease-out]`}
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
        messageCount={currentMeta?.count ?? selectedThread.message_count ?? 1}
        firstMessageAt={currentMeta?.first}
        lastMessageAt={currentMeta?.last ?? selectedThread.last_message_at}
        participants={participants}
        gmailThreadId={selectedThread.gmail_thread_id}
        threadId={selectedThread.id}
        starred={starred}
        onToggleStar={onToggleStar}
        onOpenPerson={onOpenPerson}
        onClose={handleClose}
      />
      <div className={styles.threadScroller}>
        <ThreadMessages
          threadId={selectedThread.id}
          crmOnly={crmOnly}
          onLoaded={handleLoaded}
          seedParticipants={selectedThread.participants}
          recipientName={recipientName}
          onOpenPerson={onOpenPerson}
          autoScrollOnLoad
        />
      </div>
    </div>
  );
}
