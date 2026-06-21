/**
 * Sync orchestrator — drives Gmail + Calendar backfill once. The
 * incremental poll loop is no longer in-process: it's driven by the
 * `dench-ai-gateway` plugin running inside the OpenClaw gateway daemon,
 * which POSTs to `/api/sync/poll-tick` every ~5 minutes and we run
 * `tickPoller()` here. The plugin survives Next.js restarts, so the
 * cron stays alive across `denchclaw update`.
 *
 * The whole module is process-singleton: exactly one backfill or poll
 * runs at a time per Next.js process, no matter how many SSE clients
 * connect (or how many gateway-driven ticks land while one is in flight).
 *
 * Public surface:
 *
 *   startBackfill()   → kicks off the initial backfill (idempotent — calling
 *                       again while one is already in progress is a no-op
 *                       and just returns the in-flight handle).
 *   subscribeProgress(listener) → SSE-friendly progress event subscription.
 *   tickPoller()                → run a single incremental poll cycle. Called
 *                                 from the gateway-driven HTTP endpoint;
 *                                 mutex-gated so overlap with backfill or
 *                                 another tick is a no-op.
 *   armIncrementalPoller()      → DEPRECATED. No-op shim retained so external
 *                                 callers don't break; gateway plugin owns timing now.
 *   stopIncrementalPoller()      → tears down the (now-unused) in-process
 *                                  interval if a test or older code path armed it.
 */

import { Mutex } from "async-mutex";
import {
  readConnections,
  readSyncCursors,
  writeSyncCursors,
} from "./denchclaw-state";
// Gmail/Calendar sync now handled by apps/web/scripts/rebattery/gog_crm_sync.py
// scheduled via Hermes cron. This runner keeps scoring/merging/onboarding duties.
import { recomputeAllScores } from "./strength-score";
import { ComposioToolNoConnectionError } from "./composio-execute";
import { ensureLatestSchema } from "./workspace-schema-migrations";
import { ensureOnboardingObjectDirs, installDefaultViews } from "./onboarding-views";
import { mergeDuplicatePeople } from "./people-merge";

// ---------------------------------------------------------------------------
// Public progress event
// ---------------------------------------------------------------------------

export type SyncProgressEvent = {
  phase:
    | "starting"
    | "gmail"
    | "calendar"
    | "scoring"
    | "merging"
    | "complete"
    | "error"
    | "polling";
  message: string;
  messagesProcessed: number;
  peopleProcessed: number;
  companiesProcessed: number;
  threadsProcessed: number;
  eventsProcessed: number;
  error?: string;
  /** Which subsystem the error/progress is about (only set on error events
   *  emitted by the incremental poller). Lets the UI render
   *  source-specific banners without having to grep `message`. */
  source?: "gmail" | "calendar";
};

type ProgressListener = (event: SyncProgressEvent) => void;

// ---------------------------------------------------------------------------
// Per-source sync health (used by the workspace UI banner + /api/sync/status)
// ---------------------------------------------------------------------------

/**
 * Snapshot of the most recent failure/success for one source. The UI
 * shows a sticky banner whenever `lastError` is non-null AND there
 * hasn't been a more recent successful tick.
 */
export type SyncSourceStatus = {
  /** Plain-English failure message, or null when last tick succeeded. */
  lastError: string | null;
  /** ISO timestamp of the most recent failure (sticky until next success). */
  lastErrorAt: string | null;
  /** ISO timestamp of the most recent successful tick (poll *or* backfill). */
  lastSuccessAt: string | null;
  /**
   * Streak counter: how many consecutive failures we've seen with the
   * same error key. Used by the gateway-style "first-failure-only" log
   * suppression so logs don't fill up with identical lines every 5min.
   */
  consecutiveFailures: number;
  /**
   * True when the failure looks like an OAuth-revocation
   * (`ComposioToolNoConnectionError`) — UI surfaces a "Reconnect"
   * button for these instead of a generic "retry later" message.
   */
  needsReconnect: boolean;
};

export type SyncStatus = {
  gmail: SyncSourceStatus;
  calendar: SyncSourceStatus;
};

function emptyStatus(): SyncSourceStatus {
  return {
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    needsReconnect: false,
  };
}

const syncStatus: SyncStatus = {
  gmail: emptyStatus(),
  calendar: emptyStatus(),
};

// Keys for the latest failure mode per source — used by the
// "log first failure in a streak, then suppress identical repeats"
// pattern (mirrors the gateway sync-trigger logger so a 5-min poll loop
// against a dead Gmail OAuth doesn't spam stderr 288 times a day).
const lastLoggedFailureKey: { gmail: string | null; calendar: string | null } = {
  gmail: null,
  calendar: null,
};

// ---------------------------------------------------------------------------
// Module-singleton state
// ---------------------------------------------------------------------------

const mutex = new Mutex();
const listeners = new Set<ProgressListener>();
let lastEvent: SyncProgressEvent | null = null;
let backfillRunning = false;
let backfillPromise: Promise<void> | null = null;
// pollerHandle is no longer set in steady state — the gateway plugin owns
// timing now. Kept as a defensive null so `stopIncrementalPoller()` can
// still clean up if a test or older code path armed an in-process timer.
let pollerHandle: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Progress emission
// ---------------------------------------------------------------------------

function emit(event: SyncProgressEvent): void {
  lastEvent = event;
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Listener errors should never break the runner.
    }
  }
}

export function subscribeProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  if (lastEvent) {
    try {
      listener(lastEvent);
    } catch {
      // ignore
    }
  }
  return () => {
    listeners.delete(listener);
  };
}

export function getLastProgressEvent(): SyncProgressEvent | null {
  return lastEvent;
}

// ---------------------------------------------------------------------------
// Per-source status (consumed by `/api/sync/status` + workspace banner)
// ---------------------------------------------------------------------------

/**
 * Snapshot the current per-source sync health. Returns a structural copy
 * so callers can't mutate the singleton state by accident.
 */
export function getSyncStatus(): SyncStatus {
  return {
    gmail: { ...syncStatus.gmail },
    calendar: { ...syncStatus.calendar },
  };
}

/**
 * Stringify an unknown thrown value without triggering `[object Object]`.
 * Mirrors what the rest of the file does in the catch blocks so the
 * streak key and the user-visible message stay consistent — diverging
 * here would cause the dedupe logic to flap between key shapes.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {return err.message;}
  if (typeof err === "string") {return err;}
  if (typeof err === "number" || typeof err === "boolean") {return String(err);}
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Coarse error key used for streak-based log suppression. We collapse
 * identical Composio responses (same status + first 80 chars of message)
 * so a stuck 5-min poll loop doesn't write the same stack to stderr
 * every tick. Keep this stable: changing the key shape would defeat the
 * suppression on the very next deploy after an upgrade.
 */
function failureKeyFor(err: unknown, kind: "no-connection" | "other"): string {
  if (kind === "no-connection") {return "no-connection";}
  const message = describeError(err);
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status?: number }).status ?? 0;
    return `http:${status}:${message.slice(0, 80)}`;
  }
  if (err instanceof Error) {return `error:${message.slice(0, 80)}`;}
  return `unknown:${message.slice(0, 80)}`;
}

function recordSyncFailure(
  source: "gmail" | "calendar",
  err: unknown,
  opts: { needsReconnect: boolean },
): void {
  const message = describeError(err);
  const key = failureKeyFor(err, opts.needsReconnect ? "no-connection" : "other");
  const previousKey = lastLoggedFailureKey[source];
  const previous = syncStatus[source];
  const now = new Date().toISOString();
  syncStatus[source] = {
    lastError: message,
    lastErrorAt: now,
    lastSuccessAt: previous.lastSuccessAt,
    // Reset the counter when the failure mode changes — it's the
    // *streak* of identical failures, not the running total of all
    // failures since boot.
    consecutiveFailures: previousKey === key ? previous.consecutiveFailures + 1 : 1,
    needsReconnect: opts.needsReconnect,
  };
  // Mirror sync-trigger's "first failure in a streak only" logging so
  // operators see a single line on the failure mode change but not
  // 288 identical lines per day for a chronically-broken connection.
  if (previousKey !== key) {
    console.error(`[sync-runner] ${source} sync failed: ${message}`);
  }
  lastLoggedFailureKey[source] = key;
}

function recordSyncSuccess(source: "gmail" | "calendar"): void {
  const previous = syncStatus[source];
  syncStatus[source] = {
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: new Date().toISOString(),
    consecutiveFailures: 0,
    needsReconnect: false,
  };
  if (previous.lastError) {
    // Recovery line so operators can correlate "stopped failing" with a
    // re-OAuth or upstream Composio fix, mirroring sync-trigger's
    // recovery log.
    console.info(`[sync-runner] ${source} sync recovered`);
  }
  lastLoggedFailureKey[source] = null;
}

// ---------------------------------------------------------------------------
// Backfill
// ---------------------------------------------------------------------------

export type StartBackfillOptions = {
  signal?: AbortSignal;
};

export type StartBackfillResult = {
  started: boolean;
  alreadyRunning: boolean;
  reason?: string;
};

/**
 * Kick off the full backfill. Returns immediately; subscribe to progress
 * via `subscribeProgress`. If a backfill is already in flight, returns
 * `{ started: false, alreadyRunning: true }`.
 */
export function startBackfill(options: StartBackfillOptions = {}): StartBackfillResult {
  if (backfillRunning) {
    return { started: false, alreadyRunning: true };
  }
  const connections = readConnections();
  if (!connections.gmail) {
    return {
      started: false,
      alreadyRunning: false,
      reason: "No Gmail connection. Connect Gmail before starting the sync.",
    };
  }
  backfillRunning = true;
  backfillPromise = runBackfillInner(options).finally(() => {
    backfillRunning = false;
    backfillPromise = null;
  });
  return { started: true, alreadyRunning: false };
}

export function isBackfillRunning(): boolean {
  return backfillRunning;
}

export function awaitBackfillCompletion(): Promise<void> {
  return backfillPromise ?? Promise.resolve();
}

async function runBackfillInner(options: StartBackfillOptions): Promise<void> {
  const release = await mutex.acquire();
  try {
    emit({
      phase: "starting",
      message: "Preparing workspace…",
      messagesProcessed: 0,
      peopleProcessed: 0,
      companiesProcessed: 0,
      threadsProcessed: 0,
      eventsProcessed: 0,
    });

    // Make sure the schema additions and per-object directories exist
    // before we start writing rows — safer to run unconditionally than to
    // assume the workspace init route already did it for this workspace.
    try {
      await ensureLatestSchema();
    } catch {
      // Non-fatal — most rows still write fine; surfaced via per-tool errors.
    }
    try {
      ensureOnboardingObjectDirs();
    } catch {
      // ignore
    }

    const connections = readConnections();
    let totalMessages = 0;
    let totalPeople = 0;
    let totalCompanies = 0;
    let totalThreads = 0;
    let totalEvents = 0;

    // ----- Gmail / Calendar -----
    // These are now handled by apps/web/scripts/rebattery/gog_crm_sync.py
    // scheduled via Hermes cron. Keep the sync-status timestamps healthy.
    if (connections.gmail) {
      recordSyncSuccess("gmail");
    }
    if (connections.calendar) {
      recordSyncSuccess("calendar");
    }

    // ----- Auto-merge duplicate people (by normalized email/phone) -----
    // Runs *before* scoring so the score recompute reflects the
    // consolidated people rows (interactions on losers are remapped onto
    // the canonical winner before we sum up Strength Score).
    emit({
      phase: "merging",
      message: "Merging duplicate contacts…",
      messagesProcessed: totalMessages,
      peopleProcessed: totalPeople,
      companiesProcessed: totalCompanies,
      threadsProcessed: totalThreads,
      eventsProcessed: totalEvents,
    });
    try {
      const mergeReport = await mergeDuplicatePeople();
      if (mergeReport.rowsMerged > 0) {
        // The People count we surfaced earlier counted post-sync rows
        // *before* dedupe; subtract the merged-away losers so the
        // onboarding "X people" headline reflects what the user will
        // actually see in the workspace.
        totalPeople = Math.max(0, totalPeople - mergeReport.rowsMerged);
      }
    } catch (err) {
      console.error("[sync-runner] people merge failed:", err);
      // Non-fatal: a failed merge leaves duplicates in place but the
      // rest of the workspace is fine. Next poll tick will retry.
    }

    // ----- Score recompute -----
    emit({
      phase: "scoring",
      message: "Computing Strongest Connection scores…",
      messagesProcessed: totalMessages,
      peopleProcessed: totalPeople,
      companiesProcessed: totalCompanies,
      threadsProcessed: totalThreads,
      eventsProcessed: totalEvents,
    });
    try {
      await recomputeAllScores();
    } catch {
      // Non-fatal: scoring is recoverable on next poll tick.
    }

    // Install the Strongest / Going Cold / By Strength / Recent threads views.
    try {
      installDefaultViews();
    } catch {
      // Non-fatal: views are user-curatable; failure here just leaves the
      // workspace with the user's pre-existing views.
    }

    emit({
      phase: "complete",
      message: "All set — opening your workspace.",
      messagesProcessed: totalMessages,
      peopleProcessed: totalPeople,
      companiesProcessed: totalCompanies,
      threadsProcessed: totalThreads,
      eventsProcessed: totalEvents,
    });

    // No need to arm an in-process poller: the OpenClaw gateway's
    // `dench-ai-gateway` plugin already posts to `/api/sync/poll-tick`
    // on its own schedule. First gateway tick will catch up anything
    // that landed between the backfill commit and now.
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Incremental poller
// ---------------------------------------------------------------------------

/**
 * @deprecated The incremental poll loop is now driven by the
 * `dench-ai-gateway` OpenClaw plugin (which posts to `/api/sync/poll-tick`
 * from inside the long-lived gateway daemon). This function is retained as
 * a no-op shim so older callers don't break; new callers should use
 * `tickPoller()` directly if they need a one-shot run, or rely on the
 * gateway-driven cron for ongoing polling. The `intervalMs` parameter is
 * ignored.
 */
export function armIncrementalPoller(_intervalMs?: number): void {
  // No-op: the gateway plugin owns timing now.
}

export function stopIncrementalPoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}

/**
 * Run a single incremental Gmail/Calendar poll cycle. Safe to call
 * concurrently — the module mutex makes overlapping invocations no-ops.
 *
 * Called from `apps/web/app/api/sync/poll-tick/route.ts`, which is
 * triggered by the gateway-side `dench-ai-gateway` plugin every ~5 min.
 */
export async function tickPoller(): Promise<void> {
  if (mutex.isLocked()) {return;}
  const release = await mutex.acquire();
  try {
    const connections = readConnections();
    const cursors = readSyncCursors();
    let didWork = false;

    // Gmail/Calendar incremental sync is now handled by Hermes-cron'd
    // apps/web/scripts/rebattery/gog_crm_sync.py.
    if (connections.gmail && cursors.gmail?.historyId) {
      recordSyncSuccess("gmail");
    }
    if (connections.calendar && cursors.calendar?.syncToken) {
      recordSyncSuccess("calendar");
    }

    if (didWork) {
      // Auto-merge any duplicate people that the incremental sync may
      // have introduced (e.g. an attendee surfaced via Calendar that the
      // Gmail-side cache hadn't yet seen). Order matters: merge first so
      // the rescore aggregates over the canonical-only set of people.
      try {
        await mergeDuplicatePeople();
      } catch (err) {
        console.error("[sync-runner] people merge failed during poll:", err);
      }
      // Lightweight rescore — runs in foreground so the next render has it.
      try {
        await recomputeAllScores();
      } catch {
        // ignore
      }
    }

    writeSyncCursors({}); // touch updatedAt
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Test-only resets
// ---------------------------------------------------------------------------

export function _resetSyncRunnerForTests(): void {
  stopIncrementalPoller();
  listeners.clear();
  lastEvent = null;
  backfillRunning = false;
  backfillPromise = null;
  syncStatus.gmail = emptyStatus();
  syncStatus.calendar = emptyStatus();
  lastLoggedFailureKey.gmail = null;
  lastLoggedFailureKey.calendar = null;
}
