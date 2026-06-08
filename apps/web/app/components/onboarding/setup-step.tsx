"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { ConnectionCard, type ConnectionStatus } from "./connection-card";
import { readOnboardingResponse } from "./response";

type DenchCloudStatus = {
  configured: boolean;
  source: "cli" | "web" | null;
  primaryModel: string | null;
};

type ConnectInitiateResponse = {
  already_connected?: boolean;
  redirect_url?: string;
  connection_id?: string | null;
  connected_account_id?: string | null;
  connect_toolkit?: string | null;
  connected_toolkit_slug?: string | null;
  connected_toolkit_name?: string | null;
  account_email?: string | null;
  account_label?: string | null;
  code?: string;
  error?: string;
};

type CallbackPayload = {
  type: string;
  status?: string;
  connected_account_id?: string;
  connected_toolkit_slug?: string | null;
  connected_toolkit_name?: string | null;
};

type ToolkitKey = "gmail" | "calendar";

type ExistingComposioConnection = {
  id?: string | null;
  connectionId?: string | null;
  toolkit_slug?: string | null;
  normalized_toolkit_slug?: string | null;
  toolkit_name?: string | null;
  status?: string | null;
  account_email?: string | null;
  account_label?: string | null;
  account?: {
    email?: string | null;
    label?: string | null;
  } | null;
  toolkit?: {
    slug?: string | null;
    name?: string | null;
  } | null;
};

type ExistingConnectionsResponse = {
  connections?: ExistingComposioConnection[];
  items?: ExistingComposioConnection[];
};

type PersistConnectionInput = {
  connectionId: string;
  toolkitSlug: string | null;
  accountEmail?: string | null;
};

const ONBOARDING_STEP_ORDER = [
  "welcome",
  "identity",
  "dench-cloud",
  "connect-gmail",
  "connect-calendar",
  "backfill",
  "skill-template",
  "complete",
] as const;

function stepIndex(step: OnboardingState["currentStep"]): number {
  return ONBOARDING_STEP_ORDER.indexOf(step);
}

function shouldAdvanceFrom(
  currentStep: OnboardingState["currentStep"],
  fromStep: OnboardingState["currentStep"],
): boolean {
  const current = stepIndex(currentStep);
  const from = stepIndex(fromStep);
  return current >= 0 && from >= 0 && current <= from;
}

function normalizeToolkitSlug(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/_/g, "-");
}

function readConnectionId(connection: ExistingComposioConnection): string | null {
  const id = connection.id ?? connection.connectionId;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function connectionToolkitSlug(connection: ExistingComposioConnection): string {
  return normalizeToolkitSlug(
    connection.normalized_toolkit_slug ??
      connection.toolkit_slug ??
      connection.toolkit?.slug,
  );
}

function connectionAccountEmail(connection: ExistingComposioConnection): string | null {
  const email = connection.account_email ?? connection.account?.email;
  return typeof email === "string" && email.includes("@") ? email : null;
}

function connectionMatchesToolkit(
  connection: ExistingComposioConnection,
  toolkit: ToolkitKey,
): boolean {
  const status = (connection.status ?? "").trim().toUpperCase();
  if (status && status !== "ACTIVE") {
    return false;
  }
  const slug = connectionToolkitSlug(connection);
  if (toolkit === "gmail") {
    return slug === "gmail";
  }
  return slug === "google-calendar" || slug === "googlecalendar";
}

/**
 * Single compact filled CTA used on active connection rows. Solid surface
 * so there is only ever one high-contrast action visible per screen at a
 * time (Fitts + clarity of intent). Styled against the project's CSS
 * variables instead of the shadcn palette, which isn't themed in this app
 * and renders as a washed-out outline.
 */
function PrimaryAction({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center justify-center rounded-md px-3 text-[12.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-45"
      style={{
        background: "var(--color-text)",
        color: "var(--color-background)",
      }}
      onMouseEnter={(e) => {
        if (!disabled) {(e.currentTarget as HTMLElement).style.opacity = "0.86";}
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = "1";
      }}
    >
      {children}
    </button>
  );
}

/** Quiet text-only secondary action (Cancel, Skip). */
function GhostAction({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-[12.5px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
      style={{ color: "var(--color-text-muted)" }}
    >
      {children}
    </button>
  );
}

/** DenchClaw workspace mark. Uses the existing asset so it themes correctly. */
function DenchCloudIcon() {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/dench-workspace-icon.png"
      alt=""
      width={28}
      height={28}
      draggable={false}
      style={{ borderRadius: 6 }}
    />
  );
}

/** Gmail brand mark (Google's official color palette). */
function GmailIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 256 193" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.825 17.455 17.455 17.455h40.727Z" fill="#4285F4" />
      <path d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-26.983 25.798-.043 98.91Z" fill="#34A853" />
      <path d="m58.182 93.14-4.174-38.655 4.174-36.945L128 69.868l69.818-52.327 4.67 34.14-4.67 41.46L128 145.467l-69.818-52.326Z" fill="#EA4335" />
      <path d="M197.818 17.538V93.14L256 49.504V26.272c0-21.564-24.61-33.858-41.89-20.89L197.818 17.54Z" fill="#FBBC04" />
      <path d="M0 49.504l26.759 20.069L58.182 93.14V17.538L41.89 5.382C24.59-7.587 0 4.708 0 26.27v23.233Z" fill="#C5221F" />
    </svg>
  );
}

/** Google Calendar brand mark (real asset). */
function GoogleCalendarIcon() {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/logos/google-calendar.png"
      alt=""
      width={26}
      height={26}
      draggable={false}
    />
  );
}

/**
 * Step 2. Consolidates Dench Cloud + Gmail + Calendar into a single
 * checklist-style screen. Each card owns its own connect logic but we keep
 * the shared surface (header, status bar, primary CTA) here so the three
 * sources feel like one setup moment, not three.
 *
 * Server-side state machine expects sequential advance events (welcome →
 * identity → dench-cloud → connect-gmail → connect-calendar → backfill).
 * We replay those under the hood on the user's behalf as they complete the
 * cards, so the wizard's notion of "where we are" stays consistent with what
 * the state machine records. When the final card lands and we're already on
 * `backfill` server-side, Continue simply moves the client view forward.
 */
export function SetupStep({
  state,
  onAdvance,
  onStageChange,
  onRefresh,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onStageChange: (stage: "empty" | "dench-cloud" | "gmail" | "calendar") => void;
  onRefresh: () => Promise<void>;
}) {
  const [denchCloudStatus, setDenchCloudStatus] = useState<DenchCloudStatus | null>(null);
  const [denchCloudLoading, setDenchCloudLoading] = useState(true);
  const [denchCloudKeyInput, setDenchCloudKeyInput] = useState("");
  const [denchCloudSubmitting, setDenchCloudSubmitting] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [denchCloudError, setDenchCloudError] = useState<string | null>(null);

  const [activeToolkit, setActiveToolkit] = useState<ToolkitKey | null>(null);
  const [toolkitError, setToolkitError] = useState<string | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [skipGmailDialogOpen, setSkipGmailDialogOpen] = useState(false);
  const [skippingGmail, setSkippingGmail] = useState(false);

  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const callbackToolkitRef = useRef<ToolkitKey | null>(null);
  const reconciledExistingConnectionsRef = useRef(false);

  // Derived connection flags. `state.denchCloud` is present whenever the user
  // has either configured it or explicitly skipped — `skipped: true` means
  // "user opted out", which for our UI counts as "not connected" (but still
  // allows the state machine to have moved forward).
  const denchCloudRecorded = Boolean(
    state.denchCloud && !state.denchCloud.skipped,
  );
  const denchCloudConnected = Boolean(
    denchCloudRecorded || denchCloudStatus?.configured,
  );
  const gmailConnected = Boolean(state.connections?.gmail);
  const calendarConnected = Boolean(state.connections?.calendar);

  // Report the furthest-reached stage up to the parent so the right pane can
  // show the matching mock fidelity without the parent having to know every
  // server-state combination.
  useEffect(() => {
    let stage: "empty" | "dench-cloud" | "gmail" | "calendar" = "empty";
    if (denchCloudConnected) {stage = "dench-cloud";}
    if (gmailConnected) {stage = "gmail";}
    if (calendarConnected) {stage = "calendar";}
    onStageChange(stage);
  }, [denchCloudConnected, gmailConnected, calendarConnected, onStageChange]);

  // Load Dench Cloud status (checks env/CLI config on disk).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", { cache: "no-store" });
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const data = (await res.json()) as DenchCloudStatus;
        if (cancelled) {return;}
        setDenchCloudStatus(data);
      } catch (err) {
        if (cancelled) {return;}
        setDenchCloudError(
          err instanceof Error ? err.message : "Could not check Dench Cloud.",
        );
      } finally {
        if (!cancelled) {setDenchCloudLoading(false);}
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // If Dench Cloud was configured via CLI but not yet recorded in onboarding
  // state, auto-accept it so the step advances without a redundant click.
  useEffect(() => {
    if (denchCloudLoading) {return;}
    if (!denchCloudStatus?.configured) {return;}
    if (state.denchCloud) {return;}
    void (async () => {
      try {
        const res = await fetch("/api/onboarding/dench-cloud", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptCli: true }),
        });
        const next = await readOnboardingResponse<OnboardingState>(res);
        onAdvance(next);
      } catch (err) {
        setDenchCloudError(
          err instanceof Error ? err.message : "Could not record Dench Cloud.",
        );
      }
    })();
  }, [
    denchCloudLoading,
    denchCloudStatus?.configured,
    state.denchCloud,
    onAdvance,
  ]);

  const stopPopupPolling = useCallback(() => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
  }, []);

  const persistToolkitConnection = useCallback(
    async (
      toolkit: ToolkitKey,
      connection: PersistConnectionInput,
      baseState: OnboardingState = state,
    ) => {
      const fromStep = toolkit === "gmail" ? "connect-gmail" : "connect-calendar";
      const toStep = toolkit === "gmail" ? "connect-calendar" : "backfill";
      const shouldAdvance = shouldAdvanceFrom(baseState.currentStep, fromStep);
      try {
        const res = await fetch("/api/onboarding/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolkit,
            connectionId: connection.connectionId,
            toolkitSlug:
              connection.toolkitSlug ??
              (toolkit === "gmail" ? "gmail" : "google-calendar"),
            accountEmail: connection.accountEmail ?? null,
            ...(shouldAdvance ? { fromStep, toStep } : {}),
          }),
        });
        const next = await readOnboardingResponse<OnboardingState>(res);
        onAdvance(next);
        return next;
      } catch (err) {
        setToolkitError(
          err instanceof Error ? err.message : "Could not save the connection.",
        );
        return baseState;
      }
    },
    [onAdvance, state],
  );

  const completeToolkit = useCallback(
    async (
      toolkit: ToolkitKey,
      connectionId: string,
      connectionToolkitSlug: string | null,
    ) => {
      await persistToolkitConnection(toolkit, {
        connectionId,
        toolkitSlug: connectionToolkitSlug,
      });
    },
    [persistToolkitConnection],
  );

  // Dench Cloud/Composio is the source of truth for OAuth. If a user already
  // connected Gmail in a prior attempt but local onboarding metadata was never
  // written, adopt that active account instead of showing a misleading
  // "Connect" button that can only end in an "already connected" error.
  useEffect(() => {
    if (!denchCloudConnected) {
      return;
    }
    if (reconciledExistingConnectionsRef.current) {
      return;
    }
    if (gmailConnected && calendarConnected) {
      return;
    }
    reconciledExistingConnectionsRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/composio/connections?include_toolkits=1&fresh=1", {
          cache: "no-store",
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as ExistingConnectionsResponse;
        const existingConnections = data.connections?.length ? data.connections : data.items ?? [];
        let nextState = state;

        const existingGmail = gmailConnected
          ? null
          : existingConnections.find((connection) => connectionMatchesToolkit(connection, "gmail"));
        const gmailId = existingGmail ? readConnectionId(existingGmail) : null;
        if (!cancelled && existingGmail && gmailId) {
          nextState = await persistToolkitConnection("gmail", {
            connectionId: gmailId,
            toolkitSlug: connectionToolkitSlug(existingGmail) || "gmail",
            accountEmail: connectionAccountEmail(existingGmail),
          }, nextState);
        }

        const existingCalendar = calendarConnected
          ? null
          : existingConnections.find((connection) => connectionMatchesToolkit(connection, "calendar"));
        const calendarId = existingCalendar ? readConnectionId(existingCalendar) : null;
        if (!cancelled && existingCalendar && calendarId) {
          nextState = await persistToolkitConnection("calendar", {
            connectionId: calendarId,
            toolkitSlug: connectionToolkitSlug(existingCalendar) || "google-calendar",
            accountEmail: connectionAccountEmail(existingCalendar),
          }, nextState);
        }
      } catch {
        // Reconciliation is opportunistic. The Connect button path below still
        // handles existing-account adoption if this probe fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    calendarConnected,
    denchCloudConnected,
    gmailConnected,
    persistToolkitConnection,
    state,
  ]);

  // Subscribe to the Composio popup's postMessage callback.
  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data as CallbackPayload | undefined;
      if (!data || data.type !== "composio-callback") {return;}
      if (event.origin !== window.location.origin) {return;}

      const toolkit = callbackToolkitRef.current;
      stopPopupPolling();
      popupRef.current = null;
      setActiveToolkit(null);
      callbackToolkitRef.current = null;

      if (!toolkit) {return;}
      if (data.status !== "success" || !data.connected_account_id) {
        setToolkitError("Connection was not completed. Please try again.");
        return;
      }
      void onRefresh();
      void completeToolkit(
        toolkit,
        data.connected_account_id,
        data.connected_toolkit_slug ?? null,
      );
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [completeToolkit, onRefresh, stopPopupPolling]);

  useEffect(() => () => stopPopupPolling(), [stopPopupPolling]);

  const startConnect = useCallback(
    async (toolkit: ToolkitKey) => {
      setActiveToolkit(toolkit);
      setToolkitError(null);
      callbackToolkitRef.current = toolkit;
      try {
        const slug = toolkit === "gmail" ? "gmail" : "google-calendar";
        const res = await fetch("/api/composio/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolkit: slug }),
        });
        const data = (await res.json()) as ConnectInitiateResponse;
        const existingConnectionId = data.connected_account_id ?? data.connection_id ?? null;
        if (data.already_connected && existingConnectionId) {
          await persistToolkitConnection(toolkit, {
            connectionId: existingConnectionId,
            toolkitSlug:
              data.connected_toolkit_slug ??
              data.connect_toolkit ??
              (toolkit === "gmail" ? "gmail" : "google-calendar"),
            accountEmail: data.account_email ?? null,
          });
          setActiveToolkit(null);
          callbackToolkitRef.current = null;
          return;
        }
        if (!res.ok) {
          if (data.code === "APP_ALREADY_CONNECTED" && existingConnectionId) {
            await persistToolkitConnection(toolkit, {
              connectionId: existingConnectionId,
              toolkitSlug:
                data.connected_toolkit_slug ??
                data.connect_toolkit ??
                (toolkit === "gmail" ? "gmail" : "google-calendar"),
              accountEmail: data.account_email ?? null,
            });
            setActiveToolkit(null);
            callbackToolkitRef.current = null;
            return;
          }
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        if (!data.redirect_url) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        const popup = window.open(
          data.redirect_url,
          "_blank",
          "popup=yes,width=560,height=720,resizable=yes,scrollbars=yes",
        );
        if (!popup) {
          throw new Error(
            "Popup was blocked. Allow popups for DenchClaw and try again.",
          );
        }
        popupRef.current = popup;
        popup.focus?.();
        popupPollRef.current = window.setInterval(() => {
          const current = popupRef.current;
          if (!current || !current.closed) {return;}
          stopPopupPolling();
          popupRef.current = null;
          if (callbackToolkitRef.current) {
            callbackToolkitRef.current = null;
            setActiveToolkit(null);
            setToolkitError(
              "The connection window was closed before authorization finished.",
            );
          }
        }, 500);
      } catch (err) {
        setActiveToolkit(null);
        callbackToolkitRef.current = null;
        setToolkitError(
          err instanceof Error ? err.message : "Could not start the connection.",
        );
      }
    },
    [persistToolkitConnection, stopPopupPolling],
  );

  async function handleDenchCloudSubmit(event: React.FormEvent) {
    event.preventDefault();
    setDenchCloudError(null);
    const trimmed = denchCloudKeyInput.trim();
    if (!trimmed) {
      setDenchCloudError("Paste your Dench Cloud API key to continue.");
      return;
    }
    setDenchCloudSubmitting(true);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
      setShowKeyForm(false);
      setDenchCloudKeyInput("");
    } catch (err) {
      setDenchCloudError(
        err instanceof Error ? err.message : "Could not save the API key.",
      );
    } finally {
      setDenchCloudSubmitting(false);
    }
  }

  async function handleDenchCloudSkip() {
    setDenchCloudSubmitting(true);
    setDenchCloudError(null);
    try {
      const res = await fetch("/api/onboarding/dench-cloud", { method: "DELETE" });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
      setShowKeyForm(false);
    } catch (err) {
      setDenchCloudError(
        err instanceof Error ? err.message : "Could not skip.",
      );
    } finally {
      setDenchCloudSubmitting(false);
    }
  }

  // Gmail is optional: when the user explicitly skips, bypass Calendar and
  // backfill but still route through starter-skill selection so the workspace
  // has a concrete first action.
  async function handleSkipGmail() {
    setToolkitError(null);
    setSkippingGmail(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: state.currentStep,
          to: "skill-template",
          skipping: "gmail",
        }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
      setSkipGmailDialogOpen(false);
    } catch (err) {
      // Close the dialog on failure so the inline error banner under the
      // setup cards becomes visible — otherwise the dialog occludes it.
      setSkipGmailDialogOpen(false);
      setToolkitError(
        err instanceof Error ? err.message : "Could not skip Gmail.",
      );
    } finally {
      setSkippingGmail(false);
    }
  }

  // Calendar is optional: when the user explicitly skips we still need to
  // advance the state machine to `backfill`.
  async function handleSkipCalendar() {
    setToolkitError(null);
    setAdvancing(true);
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "connect-calendar",
          to: "backfill",
          skipping: "calendar",
        }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
    } catch (err) {
      setToolkitError(
        err instanceof Error ? err.message : "Could not skip calendar.",
      );
    } finally {
      setAdvancing(false);
    }
  }

  const gmailBlocked = !denchCloudConnected;
  const calendarBlocked = !gmailConnected;

  const denchCloudStatusValue: ConnectionStatus = denchCloudConnected
    ? "connected"
    : denchCloudSubmitting
      ? "connecting"
      : "idle";

  const gmailStatusValue: ConnectionStatus = gmailConnected
    ? "connected"
    : activeToolkit === "gmail"
      ? "connecting"
      : gmailBlocked
        ? "blocked"
        : "idle";

  const calendarStatusValue: ConnectionStatus = calendarConnected
    ? "connected"
    : activeToolkit === "calendar"
      ? "connecting"
      : calendarBlocked
        ? "blocked"
        : "idle";

  const requiredComplete = denchCloudConnected && gmailConnected;
  // User may have skipped Dench Cloud (which also implicitly means skipping
  // Gmail). In that case they still need a path forward: the state machine
  // auto-advances through subsequent steps when DC is skipped, so we treat
  // being past `connect-calendar` as "ready for sync".
  // Continue is live as soon as the two required connections (Dench Cloud
  // + Gmail) are in place. If calendar isn't connected we silently skip
  // it on click (see handleContinueToSync). This replaces the old
  // separate "Skip" affordance on the calendar row.
  const canContinue =
    requiredComplete || state.currentStep === "backfill" || state.currentStep === "complete";

  async function handleContinueToSync() {
    setToolkitError(null);
    if (state.currentStep === "backfill") {
      // Force the parent into step 3 (the effect only listens to currentStep
      // transitions from the server; here we already are on backfill but the
      // client view is still on setup, so we re-hand the state up). Also
      // refresh to pull the latest state from the server.
      onAdvance(state);
      void onRefresh();
      return;
    }
    // On connect-calendar without a calendar connection, Continue acts
    // as the (now hidden) Skip button: mark calendar as skipped and
    // advance to backfill.
    if (state.currentStep === "connect-calendar" && !calendarConnected) {
      await handleSkipCalendar();
      return;
    }
    // When on connect-calendar and the user has already connected calendar
    // (rare — the postMessage flow usually auto-advances), push the state
    // forward manually.
    if (state.currentStep === "connect-calendar" && calendarConnected) {
      setAdvancing(true);
      try {
        const res = await fetch("/api/onboarding/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "connect-calendar", to: "backfill" }),
        });
        const next = await readOnboardingResponse<OnboardingState>(res);
        onAdvance(next);
      } catch (err) {
        setToolkitError(
          err instanceof Error ? err.message : "Could not continue.",
        );
      } finally {
        setAdvancing(false);
      }
      return;
    }
    // Otherwise refresh to let the state machine settle.
    void onRefresh();
  }

  return (
    <div className="space-y-8">
      <div>
        <h1
          className="font-instrument text-[34px] leading-[1.1] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Connect the three things that matter.
        </h1>
        <p
          className="mt-3 text-[13.5px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          Three quick connections and your workspace starts learning.
        </p>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        {/* Dench Cloud */}
        <ConnectionCard
          id="dc-card"
          required
          icon={<DenchCloudIcon />}
          title="Dench Cloud"
          description="Runs the models that power Gmail and Calendar sync."
          secondaryLabel={
            denchCloudConnected
              ? "Connected"
              : "Runs the models that power Gmail and Calendar sync."
          }
          status={denchCloudStatusValue}
          actions={
            denchCloudLoading ? (
              <span
                className="text-[12px]"
                style={{ color: "var(--color-text-muted)" }}
              >
                Checking…
              </span>
            ) : denchCloudConnected ? null : showKeyForm ? (
              <GhostAction
                onClick={() => setShowKeyForm(false)}
                disabled={denchCloudSubmitting}
              >
                Cancel
              </GhostAction>
            ) : (
              <PrimaryAction onClick={() => setShowKeyForm(true)}>
                Connect
              </PrimaryAction>
            )
          }
        />

        {showKeyForm && !denchCloudConnected && (
          <form
            onSubmit={(e) => void handleDenchCloudSubmit(e)}
            className="ml-14 space-y-3 rounded-xl px-4 py-4"
            style={{
              background: "var(--color-surface-hover)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="space-y-1.5">
              <label
                htmlFor="dench-cloud-key"
                className="text-[11px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-muted)" }}
              >
                Dench Cloud API key
              </label>
              <input
                id="dench-cloud-key"
                type="password"
                placeholder="dench_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={denchCloudKeyInput}
                onChange={(e) => setDenchCloudKeyInput(e.target.value)}
                autoComplete="off"
                autoFocus
                disabled={denchCloudSubmitting}
                className="w-full rounded-md px-3 py-2 text-[13px] outline-none transition-[border-color,box-shadow]"
                style={{
                  height: 36,
                  border: "1px solid var(--color-border)",
                  background: "var(--color-background)",
                  color: "var(--color-text)",
                }}
                onFocus={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-accent)";
                  e.currentTarget.style.boxShadow =
                    "0 0 0 3px color-mix(in oklab, var(--color-accent) 18%, transparent)";
                }}
                onBlur={(e) => {
                  e.currentTarget.style.borderColor = "var(--color-border)";
                  e.currentTarget.style.boxShadow = "none";
                }}
              />
              <p
                className="text-[11.5px]"
                style={{ color: "var(--color-text-muted)" }}
              >
                Get a key at{" "}
                <a
                  href="https://dench.com/api"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--color-accent)" }}
                >
                  dench.com/api
                </a>
                .
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => void handleDenchCloudSkip()}
                disabled={denchCloudSubmitting}
                className="text-[12px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
                style={{ color: "var(--color-text-muted)" }}
              >
                Skip — use without Gmail sync
              </button>
              <PrimaryAction type="submit" disabled={denchCloudSubmitting}>
                {denchCloudSubmitting ? "Validating…" : "Save key"}
              </PrimaryAction>
            </div>
          </form>
        )}

        {/* Gmail (recommended, but skippable with confirmation) */}
        <ConnectionCard
          icon={<GmailIcon />}
          title="Gmail"
          description="We read your inbox so People and Companies can appear."
          secondaryLabel={
            gmailConnected
              ? formatAccountLabel(state.connections?.gmail?.accountEmail)
              : gmailBlocked
                ? "Connect Dench Cloud first."
                : "We read your inbox so People and Companies can appear."
          }
          status={gmailStatusValue}
          disabledReason={gmailBlocked ? "Requires Dench Cloud." : undefined}
          actions={
            gmailConnected ? null : (
              <div className="flex items-center gap-3">
                {!gmailBlocked && (
                  <GhostAction
                    onClick={() => setSkipGmailDialogOpen(true)}
                    disabled={activeToolkit !== null || skippingGmail}
                  >
                    Skip
                  </GhostAction>
                )}
                <PrimaryAction
                  onClick={() => void startConnect("gmail")}
                  disabled={gmailBlocked || activeToolkit !== null || skippingGmail}
                >
                  {activeToolkit === "gmail" ? "Authorizing…" : "Connect"}
                </PrimaryAction>
              </div>
            )
          }
        />

        {/* Calendar (optional) */}
        <ConnectionCard
          icon={<GoogleCalendarIcon />}
          title="Google Calendar"
          description="Meetings sharpen your strongest-connection ranking. Optional."
          secondaryLabel={
            calendarConnected
              ? formatAccountLabel(state.connections?.calendar?.accountEmail)
              : calendarBlocked
                ? "Connect Gmail first."
                : "Meetings sharpen your strongest-connection ranking. Optional."
          }
          status={calendarStatusValue}
          statusLabel={
            calendarConnected
              ? "Connected"
              : state.currentStep === "backfill" && !calendarConnected
                ? "Skipped"
                : undefined
          }
          disabledReason={calendarBlocked ? "Requires Gmail." : undefined}
          actions={
            calendarConnected ? null : state.currentStep === "backfill" ? null : (
              // Calendar is optional: no explicit Skip button — the footer
              // "Continue" handles the skip path when Gmail is connected
              // but calendar isn't. Keeps the row to a single primary
              // action (Fitts's Law) and removes a decision the user
              // didn't actually need.
              <PrimaryAction
                onClick={() => void startConnect("calendar")}
                disabled={calendarBlocked || activeToolkit !== null}
              >
                {activeToolkit === "calendar" ? "Authorizing…" : "Connect"}
              </PrimaryAction>
            )
          }
        />
      </div>

      {(denchCloudError || toolkitError) && (
        <div
          className="rounded-xl px-4 py-3 text-[13px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "var(--color-error)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {denchCloudError ?? toolkitError}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {requiredComplete
            ? null
            : denchCloudConnected
              ? "Connect Gmail for the full experience, or skip ahead."
              : "Dench Cloud unlocks the other two."}
        </p>
        <button
          type="button"
          onClick={() => void handleContinueToSync()}
          disabled={!canContinue || advancing}
          className="flex h-10 items-center justify-center rounded-lg px-5 text-[13.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "#fff",
          }}
          onMouseEnter={(e) => {
            if (!advancing && canContinue) {
              (e.currentTarget as HTMLElement).style.opacity = "0.92";
            }
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.opacity = "1";
          }}
        >
          {advancing ? "Opening sync…" : "Continue"}
        </button>
      </div>

      <SkipGmailDialog
        open={skipGmailDialogOpen}
        submitting={skippingGmail}
        onCancel={() => {
          if (!skippingGmail) {setSkipGmailDialogOpen(false);}
        }}
        onConfirm={() => void handleSkipGmail()}
      />
    </div>
  );
}

/**
 * Only surface account text when we actually have a real email; otherwise
 * "Connected." reads better than a raw Composio connection id/label.
 */
function formatAccountLabel(value: string | null | undefined): string {
  if (typeof value === "string" && value.includes("@")) {return value;}
  return "Connected";
}

/**
 * Confirmation dialog for skipping Gmail. Skipping Gmail also bypasses
 * Calendar + the backfill step, so we ask explicitly rather than silently
 * committing.
 *
 * Style mirrors `keyboard-shortcuts-help.tsx` for visual consistency:
 * fixed overlay + centered surface, themed via the project's CSS
 * variables, ESC + backdrop click both dismiss. Two choices only
 * (Hick: keep the decision narrow), with the destructive-feeling action
 * on the right and a quiet Cancel on the left so muscle memory from
 * other dialogs in the app carries over.
 */
function SkipGmailDialog({
  open,
  submitting,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) {return;}
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, submitting, onCancel]);

  if (!open) {return null;}

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="skip-gmail-title"
        aria-describedby="skip-gmail-desc"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[420px] overflow-hidden rounded-2xl"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border-strong)",
          boxShadow: "var(--shadow-xl, 0 24px 60px rgba(0,0,0,0.25))",
        }}
      >
        <div className="px-6 pt-6 pb-2">
          <h2
            id="skip-gmail-title"
            className="font-instrument text-[24px] leading-tight tracking-tight"
            style={{ color: "var(--color-text)" }}
          >
            Skip Gmail sync?
          </h2>
          <p
            id="skip-gmail-desc"
            className="mt-3 text-[13.5px] leading-relaxed"
            style={{ color: "var(--color-text-muted)" }}
          >
            People, Companies, and calendar sync stay off until you connect
            Gmail later from Settings. You&apos;ll still use a starter skill next.
          </p>
        </div>
        <div
          className="flex items-center justify-end gap-4 px-6 py-4"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="text-[13px] underline-offset-4 transition-colors hover:underline disabled:opacity-50"
            style={{ color: "var(--color-text-muted)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            autoFocus
            className="flex h-10 items-center justify-center rounded-lg px-5 text-[13.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "#fff",
            }}
            onMouseEnter={(e) => {
              if (!submitting) {
                (e.currentTarget as HTMLElement).style.opacity = "0.92";
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.opacity = "1";
            }}
          >
            {submitting ? "Skipping…" : "Yes, use a starter skill"}
          </button>
        </div>
      </div>
    </div>
  );
}
