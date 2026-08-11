"use client";

import { useEffect, useState } from "react";
import type { OnboardingState } from "@/lib/denchclaw-state";
import { ConnectionCard, type ConnectionStatus } from "./connection-card";
import { readOnboardingResponse } from "./response";

type DenchCloudStatus = {
  configured: boolean;
  source: "cli" | "web" | null;
  primaryModel: string | null;
};

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
      style={{ background: "var(--color-text)", color: "var(--color-background)" }}
    >
      {children}
    </button>
  );
}

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

function DenchCloudIcon() {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/rebattery-workspace-icon.svg"
      alt=""
      width={28}
      height={28}
      draggable={false}
      style={{ borderRadius: 6 }}
    />
  );
}

/** The setup step configures ReBattery Cloud. App OAuth and sync are no longer part of onboarding. */
export function SetupStep({
  state,
  onAdvance,
  onStageChange,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onStageChange: (stage: "empty" | "dench-cloud" | "gmail" | "calendar") => void;
  onRefresh?: () => Promise<void>;
}) {
  const [status, setStatus] = useState<DenchCloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = Boolean((state.denchCloud && !state.denchCloud.skipped) || status?.configured);
  const connectionStatus: ConnectionStatus = connected ? "connected" : submitting ? "connecting" : "idle";

  useEffect(() => {
    onStageChange(connected ? "dench-cloud" : "empty");
  }, [connected, onStageChange]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/onboarding/dench-cloud", { cache: "no-store" });
        if (!response.ok) {throw new Error(`HTTP ${response.status}`);}
        const next = (await response.json()) as DenchCloudStatus;
        if (!cancelled) {setStatus(next);}
      } catch (err) {
        if (!cancelled) {setError(err instanceof Error ? err.message : "Could not check ReBattery Cloud.");}
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loading || !status?.configured || state.denchCloud) {return;}
    void (async () => {
      try {
        const response = await fetch("/api/onboarding/dench-cloud", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acceptCli: true }),
        });
        onAdvance(await readOnboardingResponse<OnboardingState>(response));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not record ReBattery Cloud.");
      }
    })();
  }, [loading, status?.configured, state.denchCloud, onAdvance]);

  async function submitKey(event: React.FormEvent) {
    event.preventDefault();
    const apiKey = keyInput.trim();
    if (!apiKey) { setError("Paste your ReBattery Cloud API key to continue."); return; }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/dench-cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      onAdvance(await readOnboardingResponse<OnboardingState>(response));
      setShowKeyForm(false);
      setKeyInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the API key.");
    } finally {
      setSubmitting(false);
    }
  }

  async function skip() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/dench-cloud", { method: "DELETE" });
      onAdvance(await readOnboardingResponse<OnboardingState>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not skip ReBattery Cloud.");
    } finally {
      setSubmitting(false);
    }
  }

  async function continueSetup() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/onboarding/dench-cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acceptCli: true }),
      });
      onAdvance(await readOnboardingResponse<OnboardingState>(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-instrument text-[34px] leading-[1.1] tracking-tight" style={{ color: "var(--color-text)" }}>
          Set up your workspace.
        </h1>
        <p className="mt-3 text-[13.5px] leading-relaxed" style={{ color: "var(--color-text-muted)" }}>
          Connect ReBattery Cloud to power your workspace. Connected services are available later through the Composio CLI.
        </p>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        <ConnectionCard
          id="dc-card"
          required
          icon={<DenchCloudIcon />}
          title="ReBattery Cloud"
          description="Runs the models that power your workspace."
          secondaryLabel={connected ? "Connected" : "Connect your ReBattery Cloud API key."}
          status={connectionStatus}
          actions={loading ? (
            <span className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>Checking…</span>
          ) : connected ? null : showKeyForm ? (
            <GhostAction onClick={() => setShowKeyForm(false)} disabled={submitting}>Cancel</GhostAction>
          ) : (
            <PrimaryAction onClick={() => setShowKeyForm(true)}>Connect</PrimaryAction>
          )}
        />
      </div>

      {showKeyForm && !connected && (
        <form onSubmit={(event) => void submitKey(event)} className="space-y-3 rounded-xl px-4 py-4" style={{ background: "var(--color-surface-hover)", border: "1px solid var(--color-border)" }}>
          <label htmlFor="dench-cloud-key" className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: "var(--color-text-muted)" }}>
            ReBattery Cloud API key
          </label>
          <input
            id="dench-cloud-key"
            type="password"
            placeholder="Paste API key"
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value)}
            autoComplete="off"
            autoFocus
            disabled={submitting}
            className="w-full rounded-md px-3 py-2 text-[13px] outline-none"
            style={{ height: 36, border: "1px solid var(--color-border)", background: "var(--color-background)", color: "var(--color-text)" }}
          />
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => void skip()} disabled={submitting} className="text-[12px] underline-offset-4 transition-colors hover:underline disabled:opacity-50" style={{ color: "var(--color-text-muted)" }}>
              Skip for now
            </button>
            <PrimaryAction type="submit" disabled={submitting}>{submitting ? "Validating…" : "Save key"}</PrimaryAction>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-xl px-4 py-3 text-[13px]" style={{ background: "rgba(239, 68, 68, 0.08)", color: "var(--color-error)", border: "1px solid rgba(239, 68, 68, 0.2)" }}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <p className="text-[12px]" style={{ color: "var(--color-text-muted)" }}>
          {connected ? "Your workspace is ready for the next step." : "You can connect ReBattery Cloud later."}
        </p>
        <button
          type="button"
          onClick={() => void continueSetup()}
          disabled={!connected || submitting}
          className="flex h-10 items-center justify-center rounded-lg px-5 text-[13.5px] font-medium transition-opacity disabled:opacity-50"
          style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}
