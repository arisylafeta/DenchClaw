"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Visual stages for the workspace mock on Step 2. The mock gains fidelity as
 * each integration connects. On Step 3 we hand it a real `liveStats` object
 * and switch to `live` mode: rows remain sample-shaped (we don't have the
 * user's actual contacts rendered here — that's the real workspace) but the
 * counters on top stream real numbers from the SSE feed.
 */
export type WorkspaceMockStage =
  | "empty"
  | "dench-cloud"
  | "gmail"
  | "calendar"
  | "live";

export type LiveStats = {
  messages: number;
  people: number;
  companies: number;
  events: number;
  phaseLabel?: string;
  phaseDetail?: string;
};

type SampleRow = {
  initials: string;
  name: string;
  company: string;
  tint: string;
  emailCount: number;
  meetingCount: number;
  score: number;
};

// Neutral, made-up contacts.
const SAMPLE_ROWS: SampleRow[] = [
  { initials: "AC", name: "Alex Carter", company: "Northwind Labs", tint: "#f97316", emailCount: 142, meetingCount: 18, score: 96 },
  { initials: "RK", name: "Riya Kapoor", company: "Formstone", tint: "#6366f1", emailCount: 118, meetingCount: 12, score: 91 },
  { initials: "MO", name: "Marcus Ono", company: "Cobalt & Co.", tint: "#10b981", emailCount: 97, meetingCount: 9, score: 84 },
  { initials: "SP", name: "Sana Pereira", company: "Lumen Works", tint: "#ec4899", emailCount: 88, meetingCount: 7, score: 78 },
  { initials: "DL", name: "Dan Liang", company: "Driftline", tint: "#f59e0b", emailCount: 76, meetingCount: 5, score: 71 },
  { initials: "NV", name: "Nia Varga", company: "Meridian", tint: "#14b8a6", emailCount: 64, meetingCount: 3, score: 65 },
  { initials: "TB", name: "Theo Brandt", company: "Highline", tint: "#8b5cf6", emailCount: 52, meetingCount: 4, score: 59 },
  { initials: "EK", name: "Emi Kato", company: "Quiver", tint: "#ef4444", emailCount: 41, meetingCount: 2, score: 52 },
];

const COMPANY_AVATARS: Array<{ label: string; tint: string }> = [
  { label: "Nw", tint: "#f97316" },
  { label: "Fs", tint: "#6366f1" },
  { label: "Cc", tint: "#10b981" },
  { label: "Lw", tint: "#ec4899" },
  { label: "Dl", tint: "#f59e0b" },
];

function rowsVisibleFor(stage: WorkspaceMockStage): number {
  switch (stage) {
    case "empty":
      return 0;
    case "dench-cloud":
      return 2;
    case "gmail":
    case "calendar":
    case "live":
      return SAMPLE_ROWS.length;
  }
}

function showScoreColumn(stage: WorkspaceMockStage): boolean {
  return stage === "calendar" || stage === "live";
}

function showMeetingColumn(stage: WorkspaceMockStage): boolean {
  return stage === "calendar" || stage === "live";
}

export function PreviewWorkspaceMock({
  stage,
  liveStats,
}: {
  stage: WorkspaceMockStage;
  liveStats?: LiveStats;
}) {
  const visibleRows = rowsVisibleFor(stage);

  return (
    <div className="flex h-full w-full items-center justify-center px-10 py-12">
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-2xl"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
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
            style={{
              background: "var(--color-surface-hover)",
              color: "var(--color-text-muted)",
            }}
          >
            <span>denchclaw</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span>People</span>
          </div>
        </div>

        <div className="grid grid-cols-[120px_1fr] min-h-[380px]">
          <aside
            className="flex flex-col gap-3 px-3 py-4"
            style={{
              background: "var(--color-sidebar-bg)",
              borderRight: "1px solid var(--color-border)",
            }}
          >
            <SidebarItem label="People" active count={visibleRows} />
            <SidebarItem
              label="Companies"
              count={visibleRows > 0 ? Math.max(2, Math.min(5, visibleRows)) : 0}
            />
            <SidebarItem
              label="Inbox"
              count={stage === "live" ? liveStats?.messages : undefined}
              muted
            />
            <SidebarItem
              label="Calendar"
              count={
                showMeetingColumn(stage)
                  ? stage === "live"
                    ? liveStats?.events
                    : 34
                  : undefined
              }
              muted
            />

            {stage !== "empty" && (
              <div className="mt-auto">
                <p
                  className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.16em]"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  Pinned
                </p>
                <div className="flex flex-wrap gap-1">
                  {COMPANY_AVATARS.slice(
                    0,
                    Math.max(2, Math.min(5, visibleRows)),
                  ).map((c) => (
                    <span
                      key={c.label}
                      className="flex h-5 w-5 items-center justify-center rounded-md text-[9px] font-semibold text-white"
                      style={{ background: c.tint }}
                      title={c.label}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </aside>

          <section className="flex flex-col">
            {stage === "live" && liveStats && <LiveCounterStrip stats={liveStats} />}

            <div
              className="grid items-center gap-3 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
              style={{
                gridTemplateColumns: showScoreColumn(stage)
                  ? "1fr 80px 56px"
                  : "1fr 72px",
                color: "var(--color-text-muted)",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <span>Person</span>
              <span className="text-right">Emails</span>
              {showScoreColumn(stage) && <span className="text-right">Score</span>}
            </div>

            <ol className="flex flex-col">
              {SAMPLE_ROWS.map((row, idx) => {
                const revealed = idx < visibleRows;
                return (
                  <MockRow
                    key={row.initials}
                    row={row}
                    revealed={revealed}
                    showScore={showScoreColumn(stage)}
                  />
                );
              })}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

function SidebarItem({
  label,
  active,
  count,
  muted,
}: {
  label: string;
  active?: boolean;
  count?: number;
  muted?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between rounded-md px-2 py-1.5 text-[11px] transition-colors"
      style={{
        background: active ? "var(--color-surface)" : "transparent",
        color: active
          ? "var(--color-text)"
          : muted
            ? "var(--color-text-muted)"
            : "var(--color-text-secondary)",
        fontWeight: active ? 600 : 500,
        border: active ? "1px solid var(--color-border)" : "1px solid transparent",
      }}
    >
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className="ml-2 shrink-0 text-[10px] tabular-nums"
          style={{ color: "var(--color-text-muted)" }}
        >
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}

function MockRow({
  row,
  revealed,
  showScore,
}: {
  row: SampleRow;
  revealed: boolean;
  showScore: boolean;
}) {
  return (
    <li
      className="grid items-center gap-3 px-4 py-2 transition-[opacity,transform,background] duration-300"
      style={{
        gridTemplateColumns: showScore ? "1fr 80px 56px" : "1fr 72px",
        borderBottom: "1px solid var(--color-border)",
        opacity: revealed ? 1 : 0.35,
        transform: revealed ? "translateY(0)" : "translateY(2px)",
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {revealed ? (
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9.5px] font-semibold text-white"
            style={{ background: row.tint }}
          >
            {row.initials}
          </span>
        ) : (
          <span
            className="block h-6 w-6 shrink-0 rounded-full"
            style={{ background: "var(--color-surface-hover)" }}
          />
        )}
        <div className="min-w-0 flex-1">
          {revealed ? (
            <>
              <p
                className="truncate text-[12px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {row.name}
              </p>
              <p
                className="truncate text-[10.5px]"
                style={{ color: "var(--color-text-muted)" }}
              >
                {row.company}
              </p>
            </>
          ) : (
            <>
              <span
                className="block h-2.5 w-24 rounded"
                style={{ background: "var(--color-surface-hover)" }}
              />
              <span
                className="mt-1 block h-2 w-16 rounded"
                style={{ background: "var(--color-surface-hover)", opacity: 0.7 }}
              />
            </>
          )}
        </div>
      </div>

      <div
        className="text-right text-[11.5px] tabular-nums"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {revealed ? (
          row.emailCount.toLocaleString()
        ) : (
          <span
            className="inline-block h-2 w-8 rounded"
            style={{ background: "var(--color-surface-hover)" }}
          />
        )}
      </div>

      {showScore && <ScoreBar value={revealed ? row.score : 0} revealed={revealed} />}
    </li>
  );
}

function ScoreBar({ value, revealed }: { value: number; revealed: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <div
        className="relative h-1.5 w-10 overflow-hidden rounded-full"
        style={{ background: "var(--color-surface-hover)" }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-500"
          style={{
            width: `${revealed ? value : 0}%`,
            background: "var(--color-accent-fill)",
          }}
        />
      </div>
      <span
        className="w-6 text-right text-[10.5px] tabular-nums"
        style={{ color: "var(--color-text-muted)" }}
      >
        {revealed ? value : ""}
      </span>
    </div>
  );
}

function LiveCounterStrip({ stats }: { stats: LiveStats }) {
  return (
    <div
      className="grid grid-cols-4 gap-2 px-4 py-3"
      style={{
        background: "var(--color-surface)",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <CounterCell label="Messages" value={stats.messages} />
      <CounterCell label="People" value={stats.people} />
      <CounterCell label="Companies" value={stats.companies} />
      <CounterCell label="Events" value={stats.events} />
    </div>
  );
}

function CounterCell({ label, value }: { label: string; value: number }) {
  const display = useAnimatedNumber(value);
  return (
    <div>
      <p
        className="text-[9px] font-medium uppercase tracking-[0.16em]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </p>
      <p
        className="mt-0.5 font-instrument text-[18px] tabular-nums tracking-tight"
        style={{ color: "var(--color-text)" }}
      >
        {display.toLocaleString()}
      </p>
    </div>
  );
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
