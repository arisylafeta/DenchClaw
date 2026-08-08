"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveStats } from "./preview-workspace-mock";

/**
 * Right-pane preview for Step 3 (Sync). Mirrors the real `CrmListShell`
 * People-table layout (same header chrome, column structure, row density)
 * so the user is literally looking at a preview of the workspace they're
 * about to open.
 *
 * Real data: polls `GET /api/crm/people?limit=12` (top N by recent
 * interaction). While sync is running, `liveStats.people` ticks upward, which we
 * use as a refresh trigger so the preview updates as contacts land. When
 * the API has fewer rows than we want to show, we pad with placeholder
 * "loading" rows so the table still reads as a populated surface.
 *
 * The "lining up" animation is driven off the count of real rows
 * currently fetched — rows reveal sequentially as they arrive.
 */

type ApiPerson = {
  id: string;
  name: string | null;
  email: string | null;
  company_name: string | null;
  last_interaction_at: string | null;
  job_title: string | null;
};

type ApiResponse = { people: ApiPerson[] };

const ROW_COUNT = 12;

export function PreviewPeopleTable({ liveStats }: { liveStats?: LiveStats }) {
  const people = useLivePeople(liveStats?.people ?? 0);

  // Stable set of slot indices — we always render ROW_COUNT rows so the
  // frame height doesn't jump as data arrives. Unfilled slots show a
  // shimmer placeholder.
  const slots = useMemo(() => Array.from({ length: ROW_COUNT }, (_, i) => i), []);

  // Drip the visible-rows count upward so even when the API returns the
  // full list in one response the rows still "line up" one by one.
  const revealed = useDrippedCount(people.length);

  return (
    // `min-h-0` is the critical bit: without it the flex parent lets this
    // child grow past the pane and the top of the card (browser chrome +
    // header) gets clipped when rows populate. With it the card shrinks
    // to the available height and the <ol> below can scroll inside it.
    <div className="flex h-full min-h-0 w-full items-center justify-center px-8 py-10">
      <div
        className="flex h-full max-h-[640px] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl"
        style={{
          background: "var(--color-background)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <BrowserChrome />
        <CrmListHeader count={liveStats?.people ?? people.length} />
        <ColumnHeader />
        <ol className="flex-1 min-h-0 overflow-y-auto">
          {slots.map((idx) => {
            const person = people[idx];
            const isRevealed = idx < revealed;
            return (
              <PersonRow
                key={person?.id ?? `placeholder-${idx}`}
                person={person}
                revealed={isRevealed}
                index={idx}
              />
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/**
 * Fetches top-N people from the real API and keeps the list fresh while
 * onboarding sync is running. Re-fetches whenever the backend reports a
 * bump in `peopleProcessed` (debounced by the SSE event interval) and also
 * on a slow background interval so stale tabs eventually refresh.
 */
function useLivePeople(peopleProcessed: number): ApiPerson[] {
  const [people, setPeople] = useState<ApiPerson[]>([]);
  const inflightRef = useRef<AbortController | null>(null);

  const refresh = useMemo(() => {
    return async () => {
      inflightRef.current?.abort();
      const ctrl = new AbortController();
      inflightRef.current = ctrl;
      try {
        const res = await fetch(`/api/crm/people?limit=${ROW_COUNT}`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok) {return;}
        const data = (await res.json()) as ApiResponse;
        if (!ctrl.signal.aborted) {
          setPeople(data.people ?? []);
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {return;}
        // Transient errors are fine — the next tick will retry.
      }
    };
  }, []);

  // Kick off an immediate fetch on mount, plus a slow background refresh
  // in case SSE silently drops (we don't want the preview to go stale).
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 8_000);
    return () => {
      window.clearInterval(interval);
      inflightRef.current?.abort();
    };
  }, [refresh]);

  // Re-fetch whenever the SSE progress counter advances. We debounce on
  // the 30-contact granularity our Step 2 preview already used so we
  // don't hammer the endpoint on every single event.
  const lastRefreshBucketRef = useRef(-1);
  useEffect(() => {
    const bucket = Math.floor(peopleProcessed / 30);
    if (bucket === lastRefreshBucketRef.current) {return;}
    lastRefreshBucketRef.current = bucket;
    void refresh();
  }, [peopleProcessed, refresh]);

  return people;
}

function BrowserChrome() {
  return (
    <div
      className="flex items-center gap-2 px-4 py-2.5"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="flex gap-1.5">
        <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#ff5f57" }} />
        <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#febc2e" }} />
        <span className="block h-2.5 w-2.5 rounded-full" style={{ background: "#28c840" }} />
      </div>
      <div
        className="ml-2 flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px]"
        style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
      >
        <span>ReBattery</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span>People</span>
      </div>
    </div>
  );
}

/** Mirrors `CrmListShell`'s header exactly — title, count, subtle toolbar. */
function CrmListHeader({ count }: { count: number }) {
  const display = useAnimatedNumber(count);
  return (
    <header
      className="flex shrink-0 items-center justify-between gap-4 px-5 py-3"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="min-w-0 flex items-baseline gap-3">
        <h2
          className="font-instrument text-[19px] tracking-tight truncate"
          style={{ color: "var(--color-text)" }}
        >
          People
        </h2>
        <span className="text-[11.5px] tabular-nums" style={{ color: "var(--color-text-muted)" }}>
          {display.toLocaleString()}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <ToolbarPill label="Sort: Recent" />
        <ToolbarPill label="Filter" />
      </div>
    </header>
  );
}

function ToolbarPill({ label }: { label: string }) {
  return (
    <span
      className="rounded-md px-2 py-1 text-[10.5px]"
      style={{
        background: "var(--color-surface-hover)",
        color: "var(--color-text-muted)",
        border: "1px solid var(--color-border)",
      }}
    >
      {label}
    </span>
  );
}

// Column layout used by both header and every row so they align perfectly.
const GRID_COLS = "minmax(0,1fr) 120px 86px";

function ColumnHeader() {
  return (
    <div
      className="grid items-center gap-3 px-5 py-2 text-[10px] font-semibold uppercase tracking-[0.14em]"
      style={{
        gridTemplateColumns: GRID_COLS,
        color: "var(--color-text-muted)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <span>Person</span>
      <span>Company</span>
      <span className="text-right">Last touch</span>
    </div>
  );
}

function PersonRow({
  person,
  revealed,
  index,
}: {
  person: ApiPerson | undefined;
  revealed: boolean;
  index: number;
}) {
  return (
    <li
      className="grid items-center gap-3 px-5 py-2.5"
      style={{
        gridTemplateColumns: GRID_COLS,
        borderBottom: "1px solid var(--color-border)",
        opacity: revealed ? 1 : 0,
        transform: revealed ? "translateY(0)" : "translateY(-4px)",
        transition: `opacity 320ms ease ${index * 20}ms, transform 320ms ease ${index * 20}ms`,
      }}
    >
      {person ? <RealPerson person={person} /> : <PlaceholderPerson />}
    </li>
  );
}

function RealPerson({ person }: { person: ApiPerson }) {
  const displayName = person.name?.trim() || person.email || "Unknown";
  const company = person.company_name ?? deriveCompanyFromEmail(person.email);
  const lastTouch = formatRelative(person.last_interaction_at);
  const subtitle = person.job_title?.trim() || person.email || "";

  return (
    <>
      <div className="min-w-0">
        <p className="truncate text-[12.5px] font-medium" style={{ color: "var(--color-text)" }}>
          {displayName}
        </p>
        {subtitle && (
          <p className="truncate text-[10.5px]" style={{ color: "var(--color-text-muted)" }}>
            {subtitle}
          </p>
        )}
      </div>

      <p className="truncate text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
        {company ?? ""}
      </p>

      <p
        className="text-right text-[11.5px] tabular-nums"
        style={{ color: "var(--color-text-muted)" }}
      >
        {lastTouch}
      </p>
    </>
  );
}

/**
 * Shimmer-style placeholder row shown for slots that don't yet have data.
 * Keeps the table height stable while real contacts are still loading.
 */
function PlaceholderPerson() {
  return (
    <>
      <div className="min-w-0">
        <span
          className="block h-2.5 w-32 rounded"
          style={{ background: "var(--color-surface-hover)" }}
        />
        <span
          className="mt-1 block h-2 w-20 rounded"
          style={{ background: "var(--color-surface-hover)", opacity: 0.7 }}
        />
      </div>
      <span
        className="block h-2.5 w-20 rounded"
        style={{ background: "var(--color-surface-hover)" }}
      />
      <span
        className="block h-2 w-12 justify-self-end rounded"
        style={{ background: "var(--color-surface-hover)" }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function deriveCompanyFromEmail(email: string | null): string | null {
  if (!email) {return null;}
  const at = email.lastIndexOf("@");
  if (at === -1) {return null;}
  const host = email.slice(at + 1).toLowerCase();
  if (!host) {return null;}
  // Drop the TLD and title-case the label so "acme.com" → "Acme".
  const label = host.split(".")[0] ?? host;
  if (!label) {return null;}
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatRelative(iso: string | null): string {
  if (!iso) {return "—";}
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {return "—";}
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) {return "Just now";}
  if (mins < 60) {return `${mins}m ago`;}
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {return `${hrs}h ago`;}
  const days = Math.floor(hrs / 24);
  if (days < 7) {return `${days}d ago`;}
  const weeks = Math.floor(days / 7);
  if (weeks < 5) {return `${weeks}w ago`;}
  const months = Math.floor(days / 30);
  if (months < 12) {return `${months}mo ago`;}
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

// ─────────────────────────────────────────────────────────────────────────
// Animation helpers
// ─────────────────────────────────────────────────────────────────────────

function useDrippedCount(target: number): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (count === target) {return;}
    const timer = window.setTimeout(() => {
      setCount((prev) => (prev < target ? prev + 1 : prev - 1));
    }, 90);
    return () => window.clearTimeout(timer);
  }, [count, target]);
  return count;
}

function useAnimatedNumber(target: number): number {
  const [display, setDisplay] = useState(target);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (prefersReducedMotion) {
      setDisplay(target);
      return;
    }
    if (display === target) {return;}
    let cancelled = false;
    const start = display;
    const delta = target - start;
    const duration = Math.min(600, Math.max(200, Math.abs(delta) * 2));
    const startedAt = performance.now();
    function tick(now: number) {
      if (cancelled) {return;}
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + delta * eased));
      if (t < 1) {
        window.requestAnimationFrame(tick);
      }
    }
    window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, prefersReducedMotion]);

  return display;
}

function usePrefersReducedMotion(): boolean {
  const matches = useMemo(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  return matches;
}
