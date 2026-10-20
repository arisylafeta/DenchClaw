"use client";

import { useMemo } from "react";
import { CrmEmptyState } from "../crm-list-shell";
import { Loading, ShimmerBar } from "../../ui/shimmer";
import { ThreadListRow, ThreadListRowSkeleton } from "./thread-list-row";
import type { Thread } from "./types";

/**
 * Day grouping label for the section header above a run of threads.
 * Returns "Today / Yesterday / Tuesday / Last week / Mar 28" matching
 * Gmail's mental model.
 */
function bucketLabel(input: string | null): string {
  if (!input) {return "Earlier";}
  const ts = Date.parse(input);
  if (!Number.isFinite(ts)) {return "Earlier";}
  const date = new Date(ts);
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(now);
  const dayDiff = Math.floor((today - startOfDay(date)) / (24 * 60 * 60 * 1000));
  if (dayDiff <= 0) {return "Today";}
  if (dayDiff === 1) {return "Yesterday";}
  if (dayDiff < 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
  }
  if (dayDiff < 30) {return "Earlier this month";}
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(date);
}

/**
 * Stable, ordered list of (label, threads) tuples computed from the
 * already-DESC-sorted thread array. We don't sort here — trust the API.
 */
function groupByDay(threads: ReadonlyArray<Thread>): Array<{ label: string; threads: Thread[] }> {
  const groups: Array<{ label: string; threads: Thread[] }> = [];
  let currentLabel: string | null = null;
  for (const thread of threads) {
    const label = bucketLabel(thread.last_message_at);
    if (label !== currentLabel) {
      groups.push({ label, threads: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].threads.push(thread);
  }
  return groups;
}

export function ThreadList({
  threads,
  loading,
  selectedThreadId,
  selectedIds,
  isRead,
  onSelect,
  onToggleSelected,
}: {
  threads: ReadonlyArray<Thread>;
  loading: boolean;
  selectedThreadId: string | null;
  selectedIds: ReadonlySet<string>;
  isRead: (id: string) => boolean;
  onSelect: (thread: Thread) => void;
  onToggleSelected: (id: string) => void;
}) {
  const groups = useMemo(() => groupByDay(threads), [threads]);

  if (loading && threads.length === 0) {
    return <Loading label="Loading…">
      <section>
        <h3 className="px-4 py-1.5" style={{ background: "var(--color-bg)", borderBottom: "1px solid var(--color-border)" }}><ShimmerBar w={72} h={10} style={{ margin: "2px 0" }} /></h3>
        <div>{Array.from({ length: 9 }, (_, i) => <ThreadListRowSkeleton key={i} index={i} />)}</div>
      </section>
    </Loading>;
  }
  if (threads.length === 0) {
    return (
      <CrmEmptyState
        title="Empty"
        description="Threads land here as Gmail syncs."
      />
    );
  }

  return (
    <div className="flex flex-col">
      {groups.map((group) => (
        <section key={group.label}>
          <h3
            className="sticky top-0 z-10 px-4 py-1.5 font-normal uppercase"
            style={{
              color: "var(--color-text-muted)",
              background: "var(--color-bg)",
              borderBottom: "1px solid var(--color-border)",
              letterSpacing: "0.08em",
              fontSize: "10px",
            }}
          >
            {group.label}
          </h3>
          <ul>
            {group.threads.map((thread) => (
              <li key={thread.id}>
                <ThreadListRow
                  thread={thread}
                  selected={selectedThreadId === thread.id}
                  read={Boolean(thread.is_self) || isRead(thread.id)}
                  inBulkSelection={selectedIds.has(thread.id)}
                  onSelect={() => onSelect(thread)}
                  onToggleSelected={() => onToggleSelected(thread.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
