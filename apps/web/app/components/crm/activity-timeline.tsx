"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { CrmEmptyState, CrmLoadingState } from "./crm-list-shell";
import { formatAbsoluteDate, formatRelativeDate } from "./format-relative-date";
import { EventDetailBody } from "./event-list-item";
import { ThreadMessages } from "./inbox/thread-messages";

// ---------------------------------------------------------------------------
// Public types — mirrors GET /api/crm/people/[id]/activity
// ---------------------------------------------------------------------------

export type ActivityDirection = "Sent" | "Received" | "Internal" | null;

export type ActivityRow = {
  id: string;
  type: "Email" | "Meeting";
  direction: ActivityDirection;
  occurred_at: string | null;
  email: {
    id: string;
    thread_id: string | null;
    subject: string | null;
    snippet: string | null;
    from: {
      id: string;
      name: string | null;
      email: string | null;
      avatar_url: string | null;
    } | null;
  } | null;
  event: {
    id: string;
    title: string | null;
    start_at: string | null;
    end_at: string | null;
    meeting_type: string | null;
  } | null;
};

type ActivityResponse = {
  activities: ActivityRow[];
  total: number;
  has_more: boolean;
};

// ---------------------------------------------------------------------------
// Date bucketing
// ---------------------------------------------------------------------------

/**
 * Bucket an ISO date into one of the timeline's date sections, relative
 * to `now`. Pure function — pulled out so we can unit-test the edge
 * cases (week boundaries, month rollover, missing dates) without
 * mounting the component.
 *
 * Buckets, in display order:
 *   - "today"
 *   - "yesterday"
 *   - "this_week"      (Mon-Sun of the current calendar week, minus today / yesterday)
 *   - "last_week"      (Mon-Sun of the prior calendar week)
 *   - "this_month"     (current calendar month, minus everything above)
 *   - "older:YYYY-MM"  (one bucket per earlier month, e.g. "older:2026-02")
 *   - "unknown"        (date is null / unparseable)
 */
export function bucketByDate(
  isoOrTs: string | number | Date | null | undefined,
  now: Date,
): string {
  if (isoOrTs === null || isoOrTs === undefined) {return "unknown";}
  const ts =
    typeof isoOrTs === "string"
      ? Date.parse(isoOrTs)
      : isoOrTs instanceof Date
        ? isoOrTs.getTime()
        : isoOrTs;
  if (!Number.isFinite(ts)) {return "unknown";}
  const date = new Date(ts);

  if (sameDay(date, now)) {return "today";}
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) {return "yesterday";}

  // ISO-week boundaries (Mon = start). We compare against the START of
  // the current and previous weeks, so "this_week" stays well-defined
  // even when "today"/"yesterday" already consumed those days.
  const weekStart = startOfIsoWeek(now);
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(weekStart.getDate() - 7);
  const lastWeekEnd = new Date(weekStart); // exclusive

  if (date >= weekStart && date <= now) {return "this_week";}
  if (date >= lastWeekStart && date < lastWeekEnd) {return "last_week";}

  // Earlier this month — e.g. it's Apr 18 and the message is Apr 2.
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "this_month";
  }

  // Older — group by year-month so the headers read "April 2026".
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `older:${yyyy}-${mm}`;
}

/**
 * Human label for a bucket key. Stable strings for the in-set buckets,
 * derived "Month YYYY" for the dynamic `older:YYYY-MM` keys.
 */
export function bucketLabel(key: string): string {
  switch (key) {
    case "today":
      return "Today";
    case "yesterday":
      return "Yesterday";
    case "this_week":
      return "Earlier this week";
    case "last_week":
      return "Last week";
    case "this_month":
      return "Earlier this month";
    case "unknown":
      return "Unknown date";
    default: {
      const m = /^older:(\d{4})-(\d{2})$/.exec(key);
      if (!m) {return key;}
      const year = Number(m[1]);
      const month = Number(m[2]) - 1;
      return new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(new Date(year, month, 1));
    }
  }
}

const FIXED_BUCKET_ORDER = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
] as const;

/**
 * Stable sort comparator for bucket keys: fixed buckets first in their
 * canonical order, then "older:YYYY-MM" buckets in reverse-chronological
 * order, and finally "unknown" at the bottom.
 */
function compareBuckets(a: string, b: string): number {
  const ai = FIXED_BUCKET_ORDER.indexOf(a as (typeof FIXED_BUCKET_ORDER)[number]);
  const bi = FIXED_BUCKET_ORDER.indexOf(b as (typeof FIXED_BUCKET_ORDER)[number]);
  if (ai !== -1 && bi !== -1) {return ai - bi;}
  if (ai !== -1) {return -1;}
  if (bi !== -1) {return 1;}
  if (a === "unknown") {return 1;}
  if (b === "unknown") {return -1;}
  // Both are "older:YYYY-MM" → string compare DESC pushes newer dates up.
  return a < b ? 1 : a > b ? -1 : 0;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function startOfIsoWeek(d: Date): Date {
  const out = new Date(d);
  const day = out.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  out.setDate(out.getDate() - diff);
  out.setHours(0, 0, 0, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

/**
 * Per-person activity timeline. Renders the most recent interactions in
 * date-bucketed sections (Today / Yesterday / This week / Last week /
 * Earlier this month / by-month older), with each row expandable inline
 * to the full email thread (for Email rows) or the meeting detail panel
 * (for Meeting rows).
 *
 * Pagination is "Show more" rather than infinite scroll so the sticky
 * bucket headers remain stable.
 */
export function ActivityTimeline({
  personId,
  onOpenPerson,
  onOpenCompany,
  presentation = "default",
}: {
  personId: string;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
  presentation?: "default" | "compact";
}) {
  const compact = presentation === "compact";
  const [items, setItems] = useState<ActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadPage = useCallback(
    async (pageOffset: number, signal?: AbortSignal): Promise<ActivityResponse | null> => {
      const res = await fetch(
        `/api/crm/people/${encodeURIComponent(personId)}/activity?limit=${PAGE_SIZE}&offset=${pageOffset}`,
        { cache: "no-store", signal },
      );
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      return (await res.json()) as ActivityResponse;
    },
    [personId],
  );

  // Initial load (and reload when person changes).
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setOffset(0);
    setHasMore(false);
    setExpandedId(null);
    void (async () => {
      try {
        const body = await loadPage(0, controller.signal);
        if (!body) {return;}
        setItems(body.activities);
        setTotal(body.total);
        setHasMore(body.has_more);
        setOffset(body.activities.length);
      } catch (err) {
        if ((err as Error).name === "AbortError") {return;}
        setError(err instanceof Error ? err.message : "Failed to load activity.");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [loadPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) {return;}
    setLoadingMore(true);
    try {
      const body = await loadPage(offset);
      if (!body) {return;}
      setItems((prev) => [...prev, ...body.activities]);
      setHasMore(body.has_more);
      setOffset((prev) => prev + body.activities.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more activity.");
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadPage, loadingMore, offset]);

  const grouped = useMemo(() => {
    const now = new Date();
    const buckets = new Map<string, ActivityRow[]>();
    for (const item of items) {
      const key = bucketByDate(item.occurred_at, now);
      if (!buckets.has(key)) {buckets.set(key, []);}
      buckets.get(key)!.push(item);
    }
    return Array.from(buckets.entries())
      .sort(([a], [b]) => compareBuckets(a, b));
  }, [items]);

  if (loading && items.length === 0) {
    return <CrmLoadingState label="Loading activity…" />;
  }
  if (error && items.length === 0) {
    return (
      <CrmEmptyState
        title="Couldn't load activity"
        description={error}
      />
    );
  }
  if (items.length === 0) {
    return (
      <CrmEmptyState
        title="No activity yet"
        description="Emails and meetings appear here once they're synced."
      />
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map(([key, rows]) => (
        <section key={key}>
          <h3
            className="sticky top-0 z-[1] mb-2 px-1 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]"
            style={{
              color: "var(--color-text-muted)",
              background: "var(--color-background)",
            }}
          >
            {bucketLabel(key)}
          </h3>
          <ul className={compact ? "border-t" : "space-y-2"} style={compact ? { borderColor: "var(--bt-border)" } : undefined}>
            {rows.map((item) => (
              <ActivityRowItem
                key={item.id}
                row={item}
                compact={compact}
                expanded={expandedId === item.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === item.id ? null : item.id))
                }
                onOpenPerson={onOpenPerson}
                onOpenCompany={onOpenCompany}
              />
            ))}
          </ul>
        </section>
      ))}

      {hasMore && (
        <div className="flex justify-center pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={compact ? "h-8 rounded-none px-3 text-xs shadow-none" : undefined}
            style={compact ? { background: "var(--bt-surface)", color: "var(--bt-text)", borderColor: "var(--bt-border)" } : undefined}
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? "Loading…"
              : `Show more (${(total - items.length).toLocaleString()} remaining)`}
          </Button>
        </div>
      )}
      {error && items.length > 0 && (
        <p className="text-center text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const DIRECTION_STYLE: Record<
  Exclude<ActivityDirection, null>,
  { label: string; color: string }
> = {
  Sent: { label: "You", color: "#22c55e" },
  Received: { label: "Them", color: "#3b82f6" },
  Internal: { label: "Internal", color: "#94a3b8" },
};

function ActivityRowItem({
  row,
  expanded,
  onToggle,
  onOpenPerson,
  onOpenCompany,
  compact,
}: {
  row: ActivityRow;
  expanded: boolean;
  onToggle: () => void;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
  compact: boolean;
}) {
  const dirStyle = row.direction ? DIRECTION_STYLE[row.direction] : null;
  const tintBg = dirStyle ? `${dirStyle.color}1a` : "var(--color-surface-hover)";
  const tintFg = dirStyle ? dirStyle.color : "var(--color-text-muted)";

  const title =
    row.type === "Email"
      ? row.email?.subject?.trim() || "(no subject)"
      : row.event?.title?.trim() || "(no title)";

  return (
    <li
      className={compact ? "overflow-hidden border-b" : "rounded-xl border overflow-hidden"}
      style={{
        borderColor: expanded ? "var(--color-accent)" : "var(--color-border)",
        background: compact ? "transparent" : "var(--color-surface)",
        transition: "border-color 120ms ease",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) {return;}
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="grid w-full items-start gap-3 px-4 py-3 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] transition-colors"
        style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto" }}
        onMouseEnter={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background =
            "var(--color-surface-hover)";
        }}
        onMouseLeave={(e) => {
          if (expanded) {return;}
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        {/* Type icon — direction-tinted circle */}
        <span
          className={`inline-flex h-7 w-7 items-center justify-center shrink-0 ${compact ? "rounded-none" : "rounded-full"}`}
          style={{
            background: compact ? "var(--bt-segment)" : tintBg,
            color: compact ? "var(--bt-muted)" : tintFg,
          }}
          aria-hidden
        >
          {row.type === "Email" ? <EnvelopeIcon /> : <CalendarIcon />}
        </span>

        {/* Body */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span
              className={compact ? "truncate" : "font-instrument truncate"}
              style={{
                color: "var(--color-text)",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {title}
            </span>
            {dirStyle && (
              <span
                className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0 text-[10px] uppercase tracking-[0.06em] ${compact ? "rounded-none" : "rounded-full"}`}
                style={{
                  background: compact ? "var(--bt-segment)" : `${dirStyle.color}1f`,
                  color: compact ? "var(--bt-muted)" : dirStyle.color,
                  fontWeight: 600,
                }}
              >
                {dirStyle.label}
              </span>
            )}
          </div>
          <ContextLine row={row} compact={compact} />
        </div>

        {/* Time */}
        <span
          className="text-right text-[11px] tabular-nums shrink-0"
          style={{ color: "var(--color-text-muted)" }}
          title={row.occurred_at ? formatAbsoluteDate(row.occurred_at) : undefined}
        >
          {row.occurred_at && formatRelativeDate(row.occurred_at)}
        </span>
      </div>

      {/* Inline expansion */}
      <div
        className="grid transition-[grid-template-rows] duration-[220ms] ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          {expanded && (
            <ExpandedBody
              row={row}
              onOpenPerson={onOpenPerson}
              onOpenCompany={onOpenCompany}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function ContextLine({ row, compact }: { row: ActivityRow; compact: boolean }) {
  if (row.type === "Email" && row.email) {
    const senderName =
      row.email.from?.name?.trim() || row.email.from?.email || null;
    const snippet = row.email.snippet?.trim();
    if (!senderName && !snippet) {return null;}
    return (
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
        {senderName && snippet && <span> — {snippet}</span>}
        {!senderName && snippet}
      </p>
    );
  }
  if (row.type === "Meeting" && row.event) {
    const range = formatTimeRange(row.event.start_at, row.event.end_at);
    const type = row.event.meeting_type;
    if (!range && !type) {return null;}
    return (
      <p
        className="mt-0.5 text-[12px]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {range}
        {range && type && " · "}
        {type}
      </p>
    );
  }
  return null;
}

function ExpandedBody({
  row,
  onOpenPerson,
  onOpenCompany,
}: {
  row: ActivityRow;
  onOpenPerson?: (id: string) => void;
  onOpenCompany?: (id: string) => void;
}) {
  if (row.type === "Email") {
    if (!row.email?.thread_id) {
      return (
        <div
          className="border-t px-4 py-4 text-[12px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-background)",
            color: "var(--color-text-muted)",
          }}
        >
          The thread for this message is no longer available.
        </div>
      );
    }
    return (
      <div
        className="border-t px-4 py-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-background)",
        }}
      >
        <ThreadMessages
          threadId={row.email.thread_id}
          recipientName={row.email.from?.name ?? row.email.from?.email ?? null}
          onOpenPerson={onOpenPerson}
          autoScrollOnLoad={false}
          showReply={false}
        />
      </div>
    );
  }
  if (row.type === "Meeting" && row.event) {
    return (
      <EventDetailBody
        eventId={row.event.id}
        fallbackEvent={{
          id: row.event.id,
          title: row.event.title,
          start_at: row.event.start_at,
          end_at: row.event.end_at,
          meeting_type: row.event.meeting_type,
        }}
        onOpenPerson={onOpenPerson}
        onOpenCompany={onOpenCompany}
      />
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function EnvelopeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 2v4" />
      <path d="M16 2v4" />
    </svg>
  );
}

function formatTimeRange(startIso: string | null, endIso: string | null): string | null {
  if (!startIso) {return null;}
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {return null;}
  const startStr = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(start);
  if (!endIso) {return startStr;}
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) {return startStr;}
  const endStr = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(end);
  return `${startStr} – ${endStr}`;
}
