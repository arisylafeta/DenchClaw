"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import {
  type OnboardingState,
  type OnboardingStep,
} from "@/lib/denchclaw-state";
import { IdentityStep } from "./identity-step";
import { SetupStep } from "./setup-step";
import { SkillTemplateStep } from "./skill-template-step";
import { SyncStep } from "./sync-step";
import { CompleteStep } from "./complete-step";
import { PreviewPane, type PreviewVariant } from "./preview-pane";
import { PreviewEditorial } from "./preview-editorial";
import { PreviewOrbit } from "./preview-orbit";
import { PreviewPeopleTable } from "./preview-people-table";
import {
  type LiveStats,
  type WorkspaceMockStage,
} from "./preview-workspace-mock";
import { ProfileSwitcher } from "../workspace/profile-switcher";
import { CreateWorkspaceDialog } from "../workspace/create-workspace-dialog";

type ClientStep = "identity" | "setup" | "sync" | "skill-template";

const CLIENT_STEPS: Array<{ id: ClientStep; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "setup", label: "Setup" },
  { id: "sync", label: "Sync" },
  { id: "skill-template", label: "Template" },
];

/**
 * Maps the server's fine-grained onboarding state (6 steps) onto the client's
 * compressed step view. `welcome` and `identity` collapse to Step 1. The
 * three connection steps + dench-cloud fold into a single "Setup" screen.
 * `backfill` is Sync. `skill-template` is the final choice before the full-screen landing.
 */
function clientStepFor(server: OnboardingStep): ClientStep | "complete" {
  switch (server) {
    case "welcome":
    case "identity":
      return "identity";
    case "dench-cloud":
    case "connect-gmail":
    case "connect-calendar":
      return "setup";
    case "backfill":
      return "sync";
    case "skill-template":
      return "skill-template";
    case "complete":
      return "complete";
  }
}

/**
 * Top-level split-screen orchestrator. The left pane renders the active step;
 * the right pane renders a crossfading preview that evolves as the user moves
 * through the flow (editorial → workspace mock → live counters). The navbar
 * stays minimal (logo + wordmark + theme toggle) and hosts the 3-segment
 * progress bar center-screen; completed segments are clickable to jump back.
 */
export function OnboardingWizard({
  initialState,
  workspaceCount = 1,
  activeWorkspace = null,
}: {
  initialState: OnboardingState;
  workspaceCount?: number;
  activeWorkspace?: string | null;
}) {
  const [state, setState] = useState<OnboardingState>(initialState);
  const [refreshing, setRefreshing] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

  // Back-navigation override: lets the user jump to an already-completed
  // client step without us mutating the authoritative server state. When set,
  // it takes precedence over what the server says; we clear it whenever the
  // server advances past the overridden view.
  const [clientStepOverride, setClientStepOverride] = useState<ClientStep | null>(null);

  // Live state reflected in the right preview pane.
  const [typedIdentity, setTypedIdentity] = useState<{ name: string; email: string }>(
    () => ({
      name: initialState.identity?.name ?? "",
      email: initialState.identity?.email ?? "",
    }),
  );
  const [mockStage, setMockStage] = useState<WorkspaceMockStage>("empty");
  const [liveStats, setLiveStats] = useState<LiveStats>({
    messages: 0,
    people: 0,
    companies: 0,
    events: 0,
  });

  const reloadAfterWorkspaceChange = useCallback(() => {
    window.location.reload();
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/onboarding/state", { cache: "no-store" });
      if (res.ok) {
        const next = (await res.json()) as OnboardingState;
        setState(next);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Compute the active client step (respecting any back-navigation override,
  // as long as that override is still "behind" the real server step).
  const serverClientStep = clientStepFor(state.currentStep);
  const activeClientStep: ClientStep | "complete" = useMemo(() => {
    if (!clientStepOverride) {return serverClientStep;}
    if (serverClientStep === "complete") {return "complete";}
    const currentIdx = CLIENT_STEPS.findIndex((s) => s.id === serverClientStep);
    const overrideIdx = CLIENT_STEPS.findIndex((s) => s.id === clientStepOverride);
    if (overrideIdx < currentIdx) {return clientStepOverride;}
    return serverClientStep;
  }, [serverClientStep, clientStepOverride]);

  // Clear a stale override once the server catches up.
  useEffect(() => {
    if (!clientStepOverride) {return;}
    if (serverClientStep === "complete") {
      setClientStepOverride(null);
      return;
    }
    const currentIdx = CLIENT_STEPS.findIndex((s) => s.id === serverClientStep);
    const overrideIdx = CLIENT_STEPS.findIndex((s) => s.id === clientStepOverride);
    if (overrideIdx >= currentIdx) {setClientStepOverride(null);}
  }, [serverClientStep, clientStepOverride]);

  const handleAdvance = useCallback((next: OnboardingState) => {
    setState(next);
    // Any successful submit from a step means the user is "done" with that
    // step, so clear the back-navigation override and let them fall through
    // to whatever the server considers their real current step. Without
    // this, if you came back to Step 1, pressed Continue, and the server
    // returned the same (already-past-identity) state, the UI would stay
    // stuck on Step 1 with no visible effect.
    setClientStepOverride(null);
  }, []);

  const activeIndex =
    activeClientStep === "complete"
      ? CLIENT_STEPS.length - 1
      : CLIENT_STEPS.findIndex((s) => s.id === activeClientStep);

  // Step 1 is a classic single-column sign-up style screen; steps 2+ use
  // the split-screen with a live preview on the right.
  const isSingleColumn = activeClientStep === "identity";

  // Nielsen's "user control & freedom" — always give the user an escape hatch
  // from a step they no longer want to be on. We only step back client-side
  // (the server record of what they've already done stays put); once they
  // submit again, the server short-circuits and they land back at the
  // furthest real step.
  const canGoBack =
    activeClientStep !== "complete" && activeIndex > 0;
  const previousStepLabel =
    activeIndex > 0 ? CLIENT_STEPS[activeIndex - 1]?.label ?? null : null;
  const handleBack = useCallback(() => {
    if (!canGoBack) {return;}
    const targetId = CLIENT_STEPS[activeIndex - 1]?.id;
    if (!targetId) {return;}
    setClientStepOverride(targetId);
  }, [canGoBack, activeIndex]);

  // Keyboard shortcuts so power users have a back affordance even without
  // pointing at it: Escape (universal "go back" convention) and ⌘/Ctrl-[
  // (matches browsers / macOS system apps). Disabled while typing into
  // inputs so Escape keeps its role of dismissing form errors, autocomplete,
  // etc. inside the step.
  useEffect(() => {
    if (!canGoBack) {return;}
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable === true;
      if (typing) {return;}
      const isCmdBracket =
        (event.metaKey || event.ctrlKey) && event.key === "[";
      if (event.key === "Escape" || isCmdBracket) {
        event.preventDefault();
        handleBack();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canGoBack, handleBack]);

  // Decide what the preview pane should render based on the active step and
  // current connection progress. Keyed so the pane can crossfade between
  // variants cleanly.
  const { previewVariant, previewNode, previewKey } = useMemo(() => {
    if (activeClientStep === "identity") {
      const variant: PreviewVariant = "editorial";
      return {
        previewVariant: variant,
        previewKey: "identity",
        previewNode: (
          <PreviewEditorial
            typedName={typedIdentity.name}
            typedEmail={typedIdentity.email}
          />
        ),
      };
    }
    if (activeClientStep === "setup") {
      const variant: PreviewVariant = "workspace-mock";
      return {
        previewVariant: variant,
        previewKey: "setup:orbit",
        previewNode: <PreviewOrbit />,
      };
    }
    if (activeClientStep === "sync") {
      const variant: PreviewVariant = "workspace-live";
      return {
        previewVariant: variant,
        previewKey: "sync:people-table",
        previewNode: <PreviewPeopleTable liveStats={liveStats} />,
      };
    }
    if (activeClientStep === "skill-template") {
      const variant: PreviewVariant = "workspace-live";
      return {
        previewVariant: variant,
        previewKey: "skill-template:people-table",
        previewNode: <PreviewPeopleTable liveStats={liveStats} />,
      };
    }
    return {
      previewVariant: "workspace-mock" as PreviewVariant,
      previewKey: "complete",
      previewNode: <PreviewPeopleTable liveStats={liveStats} />,
    };
  }, [activeClientStep, typedIdentity, mockStage, liveStats]);

  void previewVariant;

  if (activeClientStep === "complete") {
    return (
      <div
        className="min-h-screen w-full"
        style={{ background: "var(--color-background)" }}
      >
        <header className="flex h-16 items-center justify-between px-6 sm:px-10">
          <div className="flex items-center gap-2.5">
            <img
              src="/dench-workspace-icon.png"
              alt="DenchClaw"
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl"
              draggable={false}
            />
            <span
              className="font-instrument text-3xl tracking-tight leading-none"
              style={{ color: "var(--color-text)" }}
            >
              DenchClaw
            </span>
          </div>
          <ThemeToggle />
        </header>
        <main className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-6">
          <CompleteStep state={state} />
        </main>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen w-full"
      style={{ background: "var(--color-background)" }}
    >
      {/* Top navbar: logo + wordmark on the left (matches the main workspace
          heading style), top-bar-landed 3-segment progress center, theme
          toggle on the right. No border — navbar sits on page background. */}
      <header className="relative flex h-16 items-center justify-between gap-6 px-6 sm:px-10">
        {workspaceCount > 1 ? (
          <ProfileSwitcher
            activeWorkspaceHint={activeWorkspace}
            onWorkspaceSwitch={reloadAfterWorkspaceChange}
            onWorkspaceDelete={reloadAfterWorkspaceChange}
            onCreateWorkspace={() => setCreateWorkspaceOpen(true)}
            trigger={({ onClick, switching }) => (
              <button
                type="button"
                onClick={onClick}
                disabled={switching}
                className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 -mx-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50"
                title="Switch workspace"
              >
                <img
                  src="/dench-workspace-icon.png"
                  alt="DenchClaw"
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-xl"
                  draggable={false}
                />
                <span
                  className="font-instrument text-3xl tracking-tight leading-none"
                  style={{ color: "var(--color-text)" }}
                >
                  DenchClaw
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="ml-0.5 shrink-0 transition-colors"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            )}
          />
        ) : (
          <div className="flex items-center gap-2.5">
            <img
              src="/dench-workspace-icon.png"
              alt="DenchClaw"
              width={36}
              height={36}
              className="h-9 w-9 rounded-xl"
              draggable={false}
            />
            <span
              className="font-instrument text-3xl tracking-tight leading-none"
              style={{ color: "var(--color-text)" }}
            >
              DenchClaw
            </span>
          </div>
        )}

        {/* Minimal step indicator, absolutely centered. The back affordance
            lives with the step body below (Jakob's law — that's where users
            expect it), so the centered counter here stays visually stable
            as steps change. */}
        <div
          aria-live="polite"
          className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[12px] font-medium tabular-nums tracking-tight"
          style={{ color: "var(--color-text-muted)" }}
        >
          Step {Math.max(0, activeIndex) + 1} of {CLIENT_STEPS.length}
        </div>

        <div className="flex items-center gap-2">
          {refreshing && (
            <span
              className="hidden text-[11px] uppercase tracking-wider sm:inline"
              style={{ color: "var(--color-text-muted)" }}
            >
              Syncing…
            </span>
          )}
          <ThemeToggle />
        </div>
      </header>

      {/* Body. Step 1 (Identity) is a single centered column in the style of
          a classic auth/sign-up screen — minimal, no preview pane. From
          Step 2 onward we switch to the split-screen layout so the right
          pane can show the evolving workspace preview. */}
      <div
        className={
          isSingleColumn
            ? "relative min-h-[calc(100vh-4rem)]"
            : "grid min-h-[calc(100vh-4rem)] grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
        }
      >
        {isSingleColumn && <AuthGridBackdrop />}
        <main
          className={
            isSingleColumn
              ? "relative flex min-h-[calc(100vh-4rem)] items-center justify-center px-6 pb-16 pt-6 sm:px-10"
              : "flex items-start justify-center px-6 pb-16 pt-6 sm:px-10 lg:items-center lg:pt-0"
          }
        >
          <div
            className={
              isSingleColumn
                ? "w-full max-w-[400px]"
                : "w-full max-w-[520px]"
            }
          >
            {/* Top-of-body back link. Positioned top-left (Jakob's law —
                matches wizard patterns in Stripe, Linear, Notion), labeled
                with the actual destination (Peak-End clarity), 32px tall
                (WCAG 2.5.5 minimum target size), and reachable via Escape
                or ⌘/Ctrl+[ for keyboard users. Space is reserved when it's
                absent so the step heading doesn't jump. */}
            <div className="mb-4 h-8">
              {canGoBack && previousStepLabel && (
                <button
                  type="button"
                  onClick={handleBack}
                  className="group inline-flex h-8 items-center gap-1.5 rounded-md px-2 -ml-2 text-[12.5px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  style={{ color: "var(--color-text-muted)" }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "var(--color-text)";
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color =
                      "var(--color-text-muted)";
                  }}
                  aria-label={`Back to ${previousStepLabel}`}
                  title="Back (Esc)"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="transition-transform group-hover:-translate-x-0.5"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                  Back to {previousStepLabel}
                </button>
              )}
            </div>
            <StepContent
              activeClientStep={activeClientStep}
              state={state}
              onAdvance={handleAdvance}
              onRefresh={refresh}
              onIdentityTyping={setTypedIdentity}
              onSetupStageChange={setMockStage}
              onLiveStats={setLiveStats}
            />
          </div>
        </main>

        {!isSingleColumn && (
          <aside
            className="hidden lg:flex"
            style={{ borderLeft: "1px solid var(--color-border)" }}
          >
            <PreviewPane variantKey={previewKey}>{previewNode}</PreviewPane>
          </aside>
        )}
      </div>

      <CreateWorkspaceDialog
        isOpen={createWorkspaceOpen}
        onClose={() => setCreateWorkspaceOpen(false)}
        onCreated={reloadAfterWorkspaceChange}
      />
    </div>
  );
}

function StepContent({
  activeClientStep,
  state,
  onAdvance,
  onRefresh,
  onIdentityTyping,
  onSetupStageChange,
  onLiveStats,
}: {
  activeClientStep: ClientStep | "complete";
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onRefresh: () => Promise<void>;
  onIdentityTyping: (v: { name: string; email: string }) => void;
  onSetupStageChange: (stage: WorkspaceMockStage) => void;
  onLiveStats: (stats: LiveStats) => void;
}) {
  switch (activeClientStep) {
    case "identity":
      return (
        <IdentityStep
          state={state}
          onAdvance={onAdvance}
          onTypingChange={onIdentityTyping}
        />
      );
    case "setup":
      return (
        <SetupStep
          state={state}
          onAdvance={onAdvance}
          onRefresh={onRefresh}
          onStageChange={(stage) => onSetupStageChange(stage as WorkspaceMockStage)}
        />
      );
    case "sync":
      return (
        <SyncStep
          state={state}
          onAdvance={onAdvance}
          onLiveStats={onLiveStats}
        />
      );
    case "skill-template":
      return <SkillTemplateStep state={state} onAdvance={onAdvance} />;
    case "complete":
      return <CompleteStep state={state} />;
  }
}

/**
 * Subtle grid background for the single-column auth-style step (Step 1).
 * CSS repeating linear-gradients so it scales infinitely and respects the
 * theme via `--color-border`. Purely decorative; sits behind the form.
 */
function AuthGridBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage:
          "linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)",
        backgroundSize: "48px 48px",
        // Soft "hole" in the middle where the form lives — grid stays crisp
        // toward the edges and fades out behind the content so it never
        // competes with the text.
        maskImage:
          "radial-gradient(ellipse 90% 75% at 50% 50%, transparent 5%, black 100%)",
        WebkitMaskImage:
          "radial-gradient(ellipse 90% 75% at 50% 50%, transparent 5%, black 100%)",
        opacity: 0.7,
      }}
    />
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Avoid hydration mismatch: theme is only known after mount.
  if (!mounted) return <div className="h-9 w-9" />;
  const isDark = resolvedTheme === "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex h-9 w-9 items-center justify-center rounded-full bg-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      style={{ color: "var(--color-text-muted)" }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.color = "var(--color-text)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.color =
          "var(--color-text-muted)";
      }}
    >
      {isDark ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2" />
          <path d="M12 20v2" />
          <path d="m4.93 4.93 1.41 1.41" />
          <path d="m17.66 17.66 1.41 1.41" />
          <path d="M2 12h2" />
          <path d="M20 12h2" />
          <path d="m6.34 17.66-1.41 1.41" />
          <path d="m19.07 4.93-1.41 1.41" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}
