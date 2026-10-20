"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { InboxLayout } from "./inbox-layout";
import { InboxToolbar } from "./inbox-toolbar";
import { ThreadList } from "./thread-list";
import { ConversationPane } from "./conversation-pane";
import { KeyboardShortcutsHelp } from "./keyboard-shortcuts-help";
import { useInboxHotkeys } from "./use-inbox-hotkeys";
import {
  useReadState,
  useSelectedThreads,
  useStarredThreads,
} from "@/lib/crm-inbox-state";
import type { Thread } from "./types";
import type { MailMessageListRow, MailPage } from "@/lib/mail-types";
import { mailCounterparty } from "@/lib/mail-counterparty";

const DEFAULT_LIMIT = 100;

/**
 * Top-level Inbox component for the CRM main panel. Composes:
 *
 *   InboxLayout (two-pane resizable)
 *   ├─ left: InboxToolbar + ThreadList
 *   └─ right: ConversationPane
 *
 * Owns:
 *   - URL state: ?crm=inbox&q=…&sender=person|all|automated&thread=<id>
 *   - Server fetch (debounced on search)
 *   - Selection/star/read state via the localStorage hooks
 *   - Keyboard navigation (j/k/o/Enter/Esc/x/s/e/?/“/”)
 */
export function ConversationsView({
  onOpenPerson, query = "", onSearchChange,
}: {
  onOpenPerson?: (id: string) => void;
  query?: string;
  onSearchChange: (value: string) => void;
}) {
  const searchParams = useSearchParams();

  // ─── URL state ─────────────────────────────────────────────────────────
  const initialThread = searchParams.get("thread");
  const search = new URLSearchParams(query).get("q") ?? "";
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(initialThread);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Persisted local state (star / read / selected)
  const workspaceId = "default";
  const starred = useStarredThreads(workspaceId);
  const readState = useReadState(workspaceId);
  const selection = useSelectedThreads(workspaceId);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRequest = useRef<AbortController | null>(null);

  // ─── Fetch (debounced on search/sender) ───────────────────────────────
  const load = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams(query);
        if (search.trim()) {params.set("q", search.trim());}
        params.set("view", "conversations");
        params.set("limit", String(DEFAULT_LIMIT));
        if (cursor) {params.set("cursor", cursor);}
        const res = await fetch(`/api/mail/messages?${params.toString()}`, {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const body = (await res.json()) as MailPage<MailMessageListRow>;
        if (signal.aborted) {return;}
        const grouped = new Map<string, Thread>();
        for (const message of body.items) {
          if (!message.thread_id) {continue;}
          grouped.set(message.thread_id, {
            id: message.thread_id, subject: message.subject, last_message_at: message.sent_at ?? message.created_at,
            message_count: message.message_count ?? 1, gmail_thread_id: null, participants: message.participants ?? [], participant_ids: message.participants?.map((person) => person.id) ?? [],
            snippet: message.body_preview, primary_sender_type: null, is_self: message.is_self,
            primary_sender_id: message.from_person_id, primary_sender_name: message.is_self ? null : message.counterparty?.name ?? null, primary_sender_email: message.from_email,
            counterparty: mailCounterparty(message),
          });
        }
        setThreads((current) => {
          if (!cursor) {return Array.from(grouped.values());}
          const combined = new Map(current.map((thread) => [thread.id, thread]));
          for (const [id, thread] of grouped) {combined.set(id, thread);}
          return Array.from(combined.values());
        });
        setNextCursor(body.nextCursor);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load inbox.");
      } finally {
        if (!signal.aborted) {setLoading(false);}
      }
    },
    [search, query],
  );

  useEffect(() => {
    if (debounceRef.current) {clearTimeout(debounceRef.current);}
    const controller = new AbortController();
    activeRequest.current = controller;
    debounceRef.current = setTimeout(() => {
      void load(controller.signal);
    }, 150);
    return () => {
      controller.abort();
      if (debounceRef.current) {clearTimeout(debounceRef.current);}
    };
  }, [load]);


  // Keep focusedIndex pointing to the selected thread.
  useEffect(() => {
    if (!selectedThreadId) {return;}
    const idx = threads.findIndex((t) => t.id === selectedThreadId);
    if (idx >= 0) {setFocusedIndex(idx);}
  }, [selectedThreadId, threads]);

  // Mark selected thread as read once loaded.
  useEffect(() => {
    if (selectedThreadId) {
      readState.setOn(selectedThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readState mutators are stable
  }, [selectedThreadId]);

  const selectedThread = useMemo(
    () => threads.find((t) => t.id === selectedThreadId) ?? null,
    [threads, selectedThreadId],
  );
  const focusedThread = threads[focusedIndex] ?? null;

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (thread: Thread) => {
      setSelectedThreadId(thread.id);
      setFocusedIndex(threads.findIndex((t) => t.id === thread.id));
    },
    [threads],
  );

  const handleClose = useCallback(() => {
    setSelectedThreadId(null);
  }, []);

  const handleBulkAction = useCallback(
    (action: "read" | "star" | "archive") => {
      const ids = Array.from(selection.set);
      if (action === "read") {
        selection.set.forEach((id) => readState.setOn(id));
      } else if (action === "star") {
        ids.forEach((id) => starred.toggle(id));
      } else {
        // Archive — no-op + toast (pending two-way sync)
        if (typeof window !== "undefined") {
          window.alert(
            "Read-only inbox — archive will work once two-way Gmail sync ships.",
          );
        }
      }
    },
    [selection, readState, starred],
  );

  // ─── Hotkeys ───────────────────────────────────────────────────────────
  useInboxHotkeys(
    {
      next: () => {
        if (threads.length === 0) {return;}
        const next = Math.min(threads.length - 1, focusedIndex + 1);
        setFocusedIndex(next);
        const thread = threads[next];
        if (thread) {handleSelect(thread);}
      },
      prev: () => {
        if (threads.length === 0) {return;}
        const prev = Math.max(0, focusedIndex - 1);
        setFocusedIndex(prev);
        const thread = threads[prev];
        if (thread) {handleSelect(thread);}
      },
      openSelected: () => {
        if (focusedThread) {handleSelect(focusedThread);}
      },
      back: () => {
        if (helpOpen) {
          setHelpOpen(false);
          return;
        }
        setSelectedThreadId(null);
      },
      focusSearch: () => {
        const input = document.querySelector<HTMLInputElement>('[aria-label="Search mail"]') ?? searchInputRef.current;
        input?.focus();
        input?.select();
      },
      toggleSelectedBulk: () => {
        if (focusedThread) {selection.toggle(focusedThread.id);}
      },
      toggleStar: () => {
        if (focusedThread) {starred.toggle(focusedThread.id);}
      },
      archiveSelected: () => {
        handleBulkAction("archive");
      },
      openHelp: () => setHelpOpen(true),
    },
    !helpOpen,
  );

  // Auto-scroll focused row into view
  useEffect(() => {
    if (!focusedThread) {return;}
    const el = document.querySelector<HTMLElement>(
      `[data-thread-row="true"][data-thread-id="${cssEscape(focusedThread.id)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }, [focusedThread]);

  return (
    <>
      <InboxLayout
        hasSelection={!!selectedThread}
        list={
          <div
            className="flex h-full min-h-0 flex-col"
            style={{ background: "var(--color-bg)" }}
          >
            <InboxToolbar
              hideSearch
              ref={searchInputRef}
              search={search}
              onSearchChange={onSearchChange}
              selectedCount={selection.set.size}
              onClearSelection={selection.clear}
              onBulkAction={handleBulkAction}
            />
            <div className="flex-1 min-h-0 overflow-y-auto">
              {error && (
                <div
                  className="px-4 py-3 text-[13px]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {error}
                </div>
              )}
              <ThreadList
                threads={threads}
                loading={loading}
                selectedThreadId={selectedThreadId}
                selectedIds={selection.set}
                isRead={readState.has}
                onSelect={handleSelect}
                onToggleSelected={selection.toggle}
              />
              {nextCursor && <button className="m-4 rounded border px-3 py-2 text-xs" disabled={loading} onClick={() => {if (activeRequest.current) {void load(activeRequest.current.signal, nextCursor);}}}>Load more conversations</button>}
            </div>
          </div>
        }
        conversation={
          <ConversationPane
            selectedThread={selectedThread}
            crmOnly={new URLSearchParams(query).get("crmOnly") !== "false"}
            starred={selectedThread ? starred.has(selectedThread.id) : false}
            onToggleStar={() => {
              if (selectedThread) {starred.toggle(selectedThread.id);}
            }}
            onOpenPerson={onOpenPerson}
            onClose={handleClose}
          />
        }
      />
      <KeyboardShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

// CSS.escape polyfill for older runtime contexts (Node test envs)
function cssEscape(value: string): string {
  if (typeof window !== "undefined" && typeof window.CSS?.escape === "function") {
    return window.CSS.escape(value);
  }
  return value.replace(/['"\\]/g, "\\$&");
}
