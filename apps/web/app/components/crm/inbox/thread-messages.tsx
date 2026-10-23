"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CrmEmptyState, CrmLoadingState } from "../crm-list-shell";
import { MessageCard } from "./message-card";
import { QuickReply } from "./quick-reply";
import type { Participant } from "./participant-chips";
import type { Message } from "./types";
import styles from "./mail.module.css";

export type ThreadDetail = {
  thread_id: string;
  messages: Message[];
  people: Participant[];
};

/**
 * The standalone "conversation reader content" — loads a thread by id,
 * renders each message as a MessageCard (latest expanded by default),
 * and shows the visual reply composer at the bottom.
 *
 * Has NO sticky header and NO pane chrome. Use cases:
 *
 *   - Inbox: rendered inside ConversationPane (which adds the sticky
 *     header + slide-in animation).
 *   - PersonProfile / CompanyProfile email tabs: rendered inline,
 *     directly underneath the clicked thread row, so the row itself acts
 *     as the conversation header.
 *
 * Optional `seedParticipants` lets the parent contribute participants
 * already on hand (e.g. from the Inbox thread row) so message-card can
 * resolve from/to chips before the detail fetch finishes.
 *
 * `recipientName` powers the QuickReply placeholder ("Reply to Sarah…").
 *
 * `initialMessageId` expands and scrolls to the clicked email; otherwise the
 * latest visible message is selected. `autoScrollOnLoad` defaults to true.
 * Without `initialMessageId`, it scrolls the LATEST message
 * into view once the detail loads. Inline expand contexts may want this
 * set to false to avoid yanking the page when a row opens far down the
 * list.
 */
export function ThreadMessages({
  threadId,
  initialMessageId,
  seedParticipants,
  recipientName,
  onOpenPerson,
  autoScrollOnLoad = true,
  showReply = true,
  crmOnly = true,
  onLoaded,
}: {
  threadId: string;
  initialMessageId?: string;
  seedParticipants?: ReadonlyArray<Participant>;
  recipientName?: string | null;
  onOpenPerson?: (id: string) => void;
  autoScrollOnLoad?: boolean;
  showReply?: boolean;
  crmOnly?: boolean;
  onLoaded?: (detail: ThreadDetail) => void;
}) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load + refresh when the thread changes.
  useEffect(() => {
    if (!threadId) {
      setDetail(null);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setDetail(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/mail/threads/${encodeURIComponent(threadId)}?crmOnly=${crmOnly}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as ThreadDetail;
        if (!controller.signal.aborted) {setDetail(body); onLoaded?.(body);}
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load this thread.");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [threadId, crmOnly, onLoaded]);

  // Hydrated participant map for MessageCard lookup. Seeded participants
  // (e.g. from the row's own data) are merged in case the detail fetch
  // is slow — so chips render immediately rather than as Unknown.
  const peopleMap = useMemo<Map<string, Participant>>(() => {
    const map = new Map<string, Participant>();
    if (detail?.people) {
      for (const p of detail.people) {map.set(p.id, p);}
    }
    if (seedParticipants) {
      for (const p of seedParticipants) {
        if (!map.has(p.id)) {map.set(p.id, p);}
      }
    }
    return map;
  }, [detail, seedParticipants]);

  // Optionally scroll to the selected message (or latest) on load. Use scrollIntoView on the
  // CONTAINER's last message rather than mutating a parent scroller, so
  // this works whether we're inside a dedicated pane or inline-expanded.
  useEffect(() => {
    if (!autoScrollOnLoad || !detail || !containerRef.current) {return;}
    requestAnimationFrame(() => {
      const selected = containerRef.current?.querySelector<HTMLElement>('[data-selected-message="true"]');
      const last = selected ?? containerRef.current?.querySelector<HTMLElement>(
        '[data-thread-message="latest"]',
      );
      last?.scrollIntoView({ block: "nearest", behavior: "auto" });
    });
  }, [detail, autoScrollOnLoad, initialMessageId]);

  if (loading && !detail) {
    return <CrmLoadingState label="Loading conversation…" />;
  }
  if (error) {
    return <CrmEmptyState title="Couldn't load this thread" description={error} />;
  }
  if (detail && detail.messages.length === 0) {
    return (
      <CrmEmptyState
        title="This thread has no messages"
        description="Likely a stub from a manual insert."
      />
    );
  }
  if (!detail) {return null;}

  const lastMessageId = detail.messages.at(-1)?.id;
  const expandedMessageId = detail.messages.some((message) => message.id === initialMessageId) ? initialMessageId : lastMessageId;
  const replyMessage = detail.messages.findLast((message) => message.direction === "inbound" && !message.is_self) ?? detail.messages.at(-1);
  const replyEmail = replyMessage?.direction === "inbound" && !replyMessage.is_self ? replyMessage.from_email ?? null : replyMessage?.to_emails?.[0] ?? null;

  return (
    <div ref={containerRef}>
      {detail.messages.map((msg) => (
        <div key={msg.id} data-thread-message={msg.id === lastMessageId ? "latest" : undefined} data-selected-message={msg.id === initialMessageId ? "true" : undefined}>
          <MessageCard
            message={msg}
            people={peopleMap}
            defaultExpanded={msg.id === expandedMessageId}
            onOpenPerson={onOpenPerson}
          />
        </div>
      ))}
      {showReply && (
        <footer className={styles.replyFooter} aria-label="Prepare reply">
          <QuickReply key={threadId} threadId={threadId} recipientName={recipientName ?? null} recipientEmail={replyEmail} subject={replyMessage?.subject ?? null} />
        </footer>
      )}
    </div>
  );
}
