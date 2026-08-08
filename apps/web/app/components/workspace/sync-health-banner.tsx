"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Sticky banner that surfaces a Gmail or Calendar sync failure as soon
 * as `/api/sync/status` reports one. Designed for the long-tail case
 * we saw in production where a Composio OAuth got revoked upstream and
 * the inbox silently froze for 3 days because `tickPoller` swallowed
 * the non-`ComposioToolNoConnectionError` and the user had no signal.
 *
 * Behaviour rules (intentional, please read before changing):
 *
 * - Polls every {@link POLL_INTERVAL_MS} (60s). 60s gives near-real-time
 *   feedback after a re-OAuth without slamming the route — the
 *   underlying gateway cron only runs every 5 min anyway, so finer
 *   polling would just show the same state repeatedly.
 * - One banner per source, in priority order: Gmail above Calendar
 *   (Gmail is the primary signal users notice missing).
 * - Dismiss is keyed on the failure mode (`errorKey`) so a dismissed
 *   banner reappears the moment the failure mode changes — e.g., the
 *   user dismisses "Reconnect Gmail", then later the connection comes
 *   back but starts returning 5xx; the new failure should not be
 *   silently honoured by the previous dismissal.
 * - "Stale poll" is a separate failure mode from "explicit error"
 *   because operators care about both: an explicit Composio 4xx is
 *   actionable today, while a stale-but-no-error tick usually means
 *   the gateway daemon crashed or the web app got OOM-killed and
 *   needs a `denchclaw start`.
 *
 * Why a persistent banner instead of a toast: a transient toast
 * disappears in 6s and the user goes "huh? was that important?".
 * Sync failures need to remain visible until either the user acts
 * (reconnect / dismiss) or the next successful poll clears the state.
 */

type SyncSourceStatus = {
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccessAt: string | null;
  lastPolledAt: string | null;
  consecutiveFailures: number;
  needsReconnect: boolean;
  stale: boolean;
};

type StatusResponse = {
  gmail: SyncSourceStatus;
  calendar: SyncSourceStatus;
  serverNow: string;
};

type BannerEntry = {
  source: "gmail" | "calendar";
  /** Stable key used for dedupe + dismiss. Changes when the failure mode changes. */
  errorKey: string;
  title: string;
  description: string;
  /** Show a "Reconnect" CTA — only true for revoked OAuth failures. */
  needsReconnect: boolean;
};

const POLL_INTERVAL_MS = 60_000;
// Backoff multiplier when the endpoint itself fails (e.g., during a
// `denchclaw update`). Caps at ~10 min to avoid a polling stampede
// after a long downtime and to give the rest of the workspace UI air.
const POLL_FAILURE_BACKOFF_CAP_MS = 10 * 60 * 1000;
const DISMISS_STORAGE_KEY = "denchclaw:sync-banner-dismissed";

function safeReadDismissedKeys(): Set<string> {
  if (typeof window === "undefined") {return new Set();}
  try {
    const raw = window.sessionStorage.getItem(DISMISS_STORAGE_KEY);
    if (!raw) {return new Set();}
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {return new Set();}
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function persistDismissedKeys(keys: Set<string>): void {
  if (typeof window === "undefined") {return;}
  try {
    window.sessionStorage.setItem(
      DISMISS_STORAGE_KEY,
      JSON.stringify(Array.from(keys)),
    );
  } catch {
    /* sessionStorage can throw in private mode; banner falls back to
     * "show until reload" semantics, which is fine for a status banner. */
  }
}

function buildEntry(
  source: "gmail" | "calendar",
  status: SyncSourceStatus,
): BannerEntry | null {
  // Three independent failure modes, evaluated in priority order:
  //
  //   1. Explicit needsReconnect — actionable, has a clear CTA.
  //   2. Other explicit error — surface the message verbatim so the
  //      user can decide whether to escalate.
  //   3. Stale poll without explicit error — usually means the timer
  //      stopped firing (gateway crashed / web app OOM); no specific
  //      error to show but worth flagging so the user runs a healthcheck.
  const sourceLabel = source === "gmail" ? "Gmail" : "Calendar";
  if (status.needsReconnect && status.lastError) {
    return {
      source,
      errorKey: `${source}:reconnect`,
      title: `${sourceLabel} sync paused`,
      description:
        "Reconnect from the Integrations panel — your OAuth connection was revoked or expired upstream.",
      needsReconnect: true,
    };
  }
  if (status.lastError) {
    // Truncate so a long stack doesn't blow out the layout. Full
    // message is in `web-app.err.log` via the new `console.error`.
    const trimmed =
      status.lastError.length > 220
        ? `${status.lastError.slice(0, 217)}…`
        : status.lastError;
    return {
      source,
      errorKey: `${source}:error:${status.lastError.slice(0, 60)}`,
      title: `${sourceLabel} sync failing`,
      description: trimmed,
      needsReconnect: false,
    };
  }
  if (status.stale) {
    return {
      source,
      errorKey: `${source}:stale:${status.lastPolledAt ?? "never"}`,
      title: `${sourceLabel} sync hasn't run recently`,
      description:
        "The workspace service may be down. Restart it to relaunch background sync.",
      needsReconnect: false,
    };
  }
  return null;
}

/**
 * Transient state for the "Refresh now" button. We track which banner
 * fired the refresh (so the spinner appears in the right place) and
 * whether it ended in an error (so we can render an inline error
 * message under that banner instead of mutating the title — which
 * would change the dedupe `errorKey` and mis-trigger dismissal logic).
 */
type RefreshUiState =
  | { phase: "idle" }
  | { phase: "in-flight"; source: "gmail" | "calendar" }
  | { phase: "error"; source: "gmail" | "calendar"; message: string };

export function SyncHealthBanner({
  /** Override for tests so we don't have to wait 60s in jsdom. */
  pollIntervalMs = POLL_INTERVAL_MS,
}: { pollIntervalMs?: number } = {}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => safeReadDismissedKeys());
  const [refreshState, setRefreshState] = useState<RefreshUiState>({ phase: "idle" });
  // Track consecutive poll failures separately from the sync failure
  // count — a 503 from `/api/sync/status` itself shouldn't masquerade
  // as a Gmail/Calendar error; it's a different operator signal.
  const failedPollsRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/sync/status", {
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
      const body = (await res.json()) as StatusResponse;
      setStatus(body);
      failedPollsRef.current = 0;
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {return;}
      failedPollsRef.current += 1;
      // Don't surface a banner for transient endpoint failures — the
      // workspace polls many endpoints during normal use and a single
      // hiccup shouldn't manifest as "Gmail is broken". We back off
      // future poll attempts though so a long-running outage doesn't
      // hammer the route.
    }
  }, []);

  useEffect(() => {
    void poll();
    let timer: ReturnType<typeof setTimeout> | null = null;
    function schedule() {
      const backoff = Math.min(
        pollIntervalMs * Math.max(1, failedPollsRef.current || 1),
        POLL_FAILURE_BACKOFF_CAP_MS,
      );
      timer = setTimeout(async () => {
        await poll();
        schedule();
      }, backoff);
    }
    schedule();
    return () => {
      if (timer) {clearTimeout(timer);}
      abortRef.current?.abort();
    };
  }, [poll, pollIntervalMs]);

  const entries = useMemo<BannerEntry[]>(() => {
    if (!status) {return [];}
    const out: BannerEntry[] = [];
    const gmail = buildEntry("gmail", status.gmail);
    if (gmail && !dismissed.has(gmail.errorKey)) {out.push(gmail);}
    const calendar = buildEntry("calendar", status.calendar);
    if (calendar && !dismissed.has(calendar.errorKey)) {out.push(calendar);}
    return out;
  }, [status, dismissed]);

  // Garbage-collect dismissed keys that no longer correspond to an
  // active failure — keeps sessionStorage from growing unboundedly
  // across long sessions where the user reconnects + breaks + reconnects.
  useEffect(() => {
    if (!status) {return;}
    const live = new Set<string>();
    const gmail = buildEntry("gmail", status.gmail);
    if (gmail) {live.add(gmail.errorKey);}
    const cal = buildEntry("calendar", status.calendar);
    if (cal) {live.add(cal.errorKey);}
    setDismissed((prev) => {
      const next = new Set<string>();
      for (const k of prev) {
        if (live.has(k)) {next.add(k);}
      }
      if (next.size === prev.size) {return prev;}
      persistDismissedKeys(next);
      return next;
    });
  }, [status]);

  const handleDismiss = useCallback((errorKey: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(errorKey);
      persistDismissedKeys(next);
      return next;
    });
  }, []);

  const handleReconnect = useCallback(() => {
    // The workspace router resolves `~integrations` as the special path
    // that opens the Integrations panel in the main pane (see
    // `apps/web/lib/workspace-links.ts` — the `~`-prefixed paths are
    // app-internal pseudo-routes alongside `~cron`, `~cloud`, `~skills`).
    //
    // Open in a new tab so the user keeps their current workspace
    // context while reconnecting — they're almost certainly mid-task
    // when the banner appears, and ripping the active pane out from
    // under them is the wrong UX.
    if (typeof window !== "undefined") {
      window.open("/?path=~integrations", "_blank", "noopener,noreferrer");
    }
  }, []);

  /**
   * "Refresh now" hits the same `/api/sync/refresh` endpoint the agent's
   * `denchclaw_refresh_sync` tool calls — incremental mode, no body.
   * On success we immediately re-poll `/api/sync/status` so the banner
   * either disappears (sync recovered) or updates with the latest error
   * (sync still broken with a possibly different message). On failure
   * we surface the message inline beneath the buttons rather than as a
   * toast, so it stays visible next to the action that produced it.
   */
  const handleRefresh = useCallback(
    async (source: "gmail" | "calendar") => {
      refreshAbortRef.current?.abort();
      const ac = new AbortController();
      refreshAbortRef.current = ac;
      setRefreshState({ phase: "in-flight", source });
      try {
        const res = await fetch("/api/sync/refresh", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "incremental" }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        // Force-refresh status so the banner reflects the new state
        // before the next 60s poll interval would otherwise pick it up.
        await poll();
        setRefreshState({ phase: "idle" });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {return;}
        const message = err instanceof Error ? err.message : "Refresh failed.";
        setRefreshState({ phase: "error", source, message });
      }
    },
    [poll],
  );

  // Cancel any in-flight refresh on unmount so the abort handler
  // doesn't fire after the component is gone (would set state on a
  // dead component otherwise).
  useEffect(() => {
    return () => {
      refreshAbortRef.current?.abort();
    };
  }, []);

  if (entries.length === 0) {return null;}

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-3 right-3 z-[9999] flex w-full max-w-sm flex-col gap-2"
    >
      {entries.map((entry) => (
        <div
          key={entry.errorKey}
          className="pointer-events-auto rounded-lg border px-3.5 py-3 shadow-lg"
          style={{
            background: "var(--color-surface)",
            borderColor: "rgba(220, 38, 38, 0.35)",
            backdropFilter: "blur(12px)",
          }}
          data-testid={`sync-health-banner-${entry.source}`}
        >
          <div className="flex items-start gap-2.5">
            <span aria-hidden className="mt-0.5 flex-shrink-0">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#dc2626"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p
                className="text-[12.5px] font-semibold leading-tight"
                style={{ color: "var(--color-text)" }}
              >
                {entry.title}
              </p>
              <p
                className="mt-1 text-[11.5px] leading-snug break-words"
                style={{ color: "var(--color-text-muted)" }}
              >
                {entry.description}
              </p>
              <div className="mt-2 flex items-center gap-2">
                {entry.needsReconnect ? (
                  <button
                    type="button"
                    onClick={handleReconnect}
                    className="rounded-md px-2 py-1 text-[11px] font-medium transition-opacity hover:opacity-90"
                    style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
                  >
                    Reconnect
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleRefresh(entry.source)}
                  // Disabled while ANY refresh is in flight, even if a
                  // different banner triggered it — the underlying
                  // `tickPoller` is mutex-gated and a second click
                  // would just be silently dropped server-side.
                  disabled={refreshState.phase === "in-flight"}
                  className="rounded-md border px-2 py-1 text-[11px] font-medium transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: "var(--color-border)",
                    color: "var(--color-text)",
                    background: "transparent",
                  }}
                  data-testid={`sync-health-refresh-${entry.source}`}
                >
                  {refreshState.phase === "in-flight" && refreshState.source === entry.source
                    ? "Refreshing\u2026"
                    : "Refresh now"}
                </button>
                <button
                  type="button"
                  onClick={() => handleDismiss(entry.errorKey)}
                  className="rounded-md px-2 py-1 text-[11px] font-medium transition-opacity hover:opacity-70"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Dismiss
                </button>
              </div>
              {refreshState.phase === "error" && refreshState.source === entry.source ? (
                <p
                  className="mt-1.5 text-[11px] leading-snug break-words"
                  style={{ color: "#dc2626" }}
                  data-testid={`sync-health-refresh-error-${entry.source}`}
                >
                  Refresh failed: {refreshState.message}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={() => handleDismiss(entry.errorKey)}
              className="ml-1 flex-shrink-0 rounded p-0.5 transition-opacity hover:opacity-60"
              style={{ color: "var(--color-text-muted)" }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
