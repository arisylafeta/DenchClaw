"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingState } from "@/lib/denchclaw-state";
import type { LiveStats } from "./preview-workspace-mock";
import {
  assertOnboardingResponseOk,
  readOnboardingResponse,
} from "./response";

type ProgressEvent = {
  phase:
    | "starting"
    | "gmail"
    | "calendar"
    | "scoring"
    | "merging"
    | "complete"
    | "error";
  message: string;
  messagesProcessed?: number;
  peopleProcessed?: number;
  companiesProcessed?: number;
  threadsProcessed?: number;
  eventsProcessed?: number;
  error?: string;
};

// Historically we let users jump in early once enough inbox messages had
// landed, but the new UX is: finish all four phases (Email, Calendar,
// Dedupe, Rank) then unlock. Kept as a named constant in case we ever
// re-introduce an "enough to be useful" shortcut.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const READY_THRESHOLD = 2_000;

/**
 * Step 3 left pane. Same design philosophy as Steps 1 & 2:
 *
 * - No eyebrow label. The right-hand preview and the single visible title
 *   carry the narrative, so we don't spend attention on a ceremonial
 *   "Step 3 · Syncing" badge (Hick's Law — one focal point per screen).
 * - A single primary action using the same accent button we ship on the
 *   other steps (visual continuity across the flow).
 * - Progress rendered as a quiet vertical list of phases with per-row
 *   ticks/spinners instead of the previous chunky numbered timeline; the
 *   latest status message sits as a muted caption below rather than inside
 *   a framed card. Keeps the surface calm and reserves visual weight for
 *   the real deliverable (the People table on the right).
 *
 * Functional behavior is unchanged: kick off backfill if not started,
 * subscribe to SSE, stream `liveStats` up to the wizard, and enable the
 * CTA once enough data has landed or the run is fully complete.
 */
export function SyncStep({
  state,
  onAdvance,
  onLiveStats,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onLiveStats?: (stats: LiveStats) => void;
}) {
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ProgressEvent | null>(null);
  const [readyToOpen, setReadyToOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  const startedExisting =
    state.backfill?.gmail?.startedAt !== undefined ||
    state.backfill?.calendar?.startedAt !== undefined;

  const beginSync = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/onboarding/sync/start", { method: "POST" });
      await assertOnboardingResponseOk(res);
      setStarted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start sync.");
    }
  }, []);

  useEffect(() => {
    if (started || startedExisting) {return;}
    void beginSync();
  }, [beginSync, started, startedExisting]);

  useEffect(() => {
    if (eventSourceRef.current) {return;}
    const es = new EventSource("/api/onboarding/sync/progress");
    eventSourceRef.current = es;

    es.addEventListener("progress", (event) => {
      try {
        const data = JSON.parse(event.data) as ProgressEvent;
        setLatest(data);
        onLiveStats?.({
          messages: data.messagesProcessed ?? 0,
          people: data.peopleProcessed ?? 0,
          companies: data.companiesProcessed ?? 0,
          events: data.eventsProcessed ?? 0,
        });
        // Only unlock the action once every phase has finished — users
        // kept getting confused when the button went live while rows were
        // still streaming in, because the right pane looked half-full.
        if (data.phase === "complete") {
          setReadyToOpen(true);
        }
        if (data.phase === "error") {
          setError(data.error ?? "Sync hit an unrecoverable error.");
        }
      } catch {
        // ignore malformed events
      }
    });

    es.addEventListener("error", () => {
      // SSE auto-reconnects; UI keeps showing the last known state.
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [onLiveStats]);

  const handleOpen = useCallback(async () => {
    setCompleting(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: "backfill", to: "skill-template" }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish onboarding.");
    } finally {
      setCompleting(false);
    }
  }, [onAdvance]);

  const phase = latest?.phase ?? "starting";

  return (
    <div className="space-y-8">
      <div>
        <h1
          className="font-instrument text-[34px] leading-[1.1] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Bringing your workspace to life.
        </h1>
        <p
          className="mt-3 text-[13.5px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          Your inbox and calendar are loading on the right. Head in as soon
          as there&apos;s enough — the rest keeps filling in quietly.
        </p>
      </div>

      <PhaseList phase={phase} latestMessage={latest?.message} />

      {error && (
        <p
          className="text-[12.5px]"
          style={{ color: "var(--color-error)" }}
        >
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {readyToOpen
            ? "All four phases are done — your workspace is ready."
            : "Hanging out until all four phases finish."}
        </p>
        <button
          type="button"
          onClick={() => void handleOpen()}
          disabled={!readyToOpen || completing}
          className="flex h-10 items-center justify-center rounded-lg px-5 text-[13.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "#fff",
          }}
          onMouseEnter={(e) => {
            if (readyToOpen && !completing) {
              (e.currentTarget as HTMLElement).style.opacity = "0.92";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          {completing ? "Loading templates…" : "Use starter skill"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Phase list — quiet, list-style status matching the Step 2 row aesthetic.
// ─────────────────────────────────────────────────────────────────────────

type PhaseDef = {
  id: ProgressEvent["phase"];
  label: string;
  helper: string;
};

// Ordered phases as the backend reports them. `starting` is intentionally
// omitted from the visible list — it's the pre-flight state and becomes
// "Email" the moment data starts moving, which is the first real signal.
const PHASES: PhaseDef[] = [
  { id: "gmail", label: "Email", helper: "Paginating through your inbox" },
  { id: "calendar", label: "Calendar", helper: "Loading meetings and attendees" },
  { id: "merging", label: "Dedupe", helper: "Merging the same person across sources" },
  { id: "scoring", label: "Rank", helper: "Scoring who matters to you most" },
];

const PHASE_ORDER: ProgressEvent["phase"][] = [
  "starting",
  "gmail",
  "calendar",
  "merging",
  "scoring",
  "complete",
];

function PhaseList({
  phase,
  latestMessage,
}: {
  phase: ProgressEvent["phase"];
  latestMessage?: string;
}) {
  const currentIdx = PHASE_ORDER.indexOf(phase);
  const allDone = phase === "complete";

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)]">
        {PHASES.map((p) => {
          const pIdx = PHASE_ORDER.indexOf(p.id);
          const done = allDone || currentIdx > pIdx;
          const active = !allDone && currentIdx === pIdx;
          const state: "done" | "active" | "pending" = done
            ? "done"
            : active
              ? "active"
              : "pending";
          return (
            <li
              key={p.id}
              className="flex items-center gap-3 py-3"
              style={{
                opacity: state === "pending" ? 0.55 : 1,
                transition: "opacity 240ms ease",
              }}
            >
              <PhaseMark state={state} />
              <div className="min-w-0 flex-1">
                <p
                  className="text-[13px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {p.label}
                </p>
                <p
                  className="mt-0.5 truncate text-[11.5px]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {active && latestMessage ? latestMessage : p.helper}
                </p>
              </div>
              <span
                className="text-[11px] tabular-nums"
                style={{ color: "var(--color-text-muted)" }}
              >
                {state === "done" ? "Done" : state === "active" ? "Working" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PhaseMark({ state }: { state: "done" | "active" | "pending" }) {
  if (state === "done") {
    return (
      <span
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
        style={{ background: "var(--color-accent)", color: "#fff" }}
        aria-label="Done"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }
  if (state === "active") {
    return (
      <span
        className="relative flex h-5 w-5 shrink-0 items-center justify-center"
        aria-label="Working"
      >
        <span
          className="absolute inset-0 rounded-full"
          style={{
            border: "2px solid var(--color-border)",
            borderTopColor: "var(--color-accent)",
            animation: "syncSpin 900ms linear infinite",
          }}
        />
        <style jsx>{`
          @keyframes syncSpin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </span>
    );
  }
  return (
    <span
      className="h-5 w-5 shrink-0 rounded-full"
      style={{ border: "1.5px solid var(--color-border)" }}
      aria-label="Pending"
    />
  );
}
