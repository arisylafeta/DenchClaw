"use client";

import { useState } from "react";
import type { OnboardingState } from "@/lib/denchclaw-state";
import {
  assertOnboardingResponseOk,
  readOnboardingResponse,
} from "./response";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Step 1 — minimal, centered sign-up style screen. Uses inline styles tied
 * to the project's CSS variables so the inputs and primary button pick up
 * the theme (light + dark) without depending on the shadcn default palette
 * tokens, which aren't wired into this app's theme.
 */
export function IdentityStep({
  state,
  onAdvance,
  onTypingChange,
}: {
  state: OnboardingState;
  onAdvance: (next: OnboardingState) => void;
  onTypingChange?: (next: { name: string; email: string }) => void;
}) {
  const [name, setName] = useState(state.identity?.name ?? "");
  const [email, setEmail] = useState(state.identity?.email ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleNameChange(next: string) {
    setName(next);
    onTypingChange?.({ name: next, email });
  }

  function handleEmailChange(next: string) {
    setEmail(next);
    onTypingChange?.({ name, email: next });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError("Please enter your name.");
      return;
    }
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError("Please enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      if (state.currentStep === "welcome") {
        const res = await fetch("/api/onboarding/state", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "welcome", to: "identity" }),
        });
        await assertOnboardingResponseOk(res);
      }

      const res = await fetch("/api/onboarding/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      const next = await readOnboardingResponse<OnboardingState>(res);
      onAdvance(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save identity.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    height: 40,
    width: "100%",
    padding: "0 12px",
    borderRadius: 8,
    border: "1px solid var(--color-border)",
    background: "var(--color-surface, var(--color-background))",
    color: "var(--color-text)",
    fontSize: 14,
    outline: "none",
    transition: "border-color 120ms ease, box-shadow 120ms ease",
  };

  return (
    <form
      className="flex flex-col items-center gap-7 text-center"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <div className="mb-4 space-y-2">
        <h1
          className="whitespace-nowrap font-instrument text-[46px] leading-[1.05] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          Let&apos;s set up your local workspace
        </h1>
        <p
          className="text-[12.5px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          Everything you know about people, finally in one place.
        </p>
      </div>

      <div className="flex w-full flex-col gap-3.5">
        <Field label="Full name" htmlFor="onboarding-name">
          <input
            id="onboarding-name"
            type="text"
            placeholder="Vedant"
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            autoComplete="name"
            autoFocus
            disabled={submitting}
            style={inputStyle}
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
        </Field>
        <Field label="Work email" htmlFor="onboarding-email">
          <input
            id="onboarding-email"
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => handleEmailChange(e.target.value)}
            autoComplete="email"
            disabled={submitting}
            style={inputStyle}
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
        </Field>
      </div>

      {error && (
        <p
          role="alert"
          className="w-full rounded-md px-3 py-2 text-left text-[12.5px]"
          style={{
            background: "rgba(239, 68, 68, 0.08)",
            color: "var(--color-error, #ef4444)",
            border: "1px solid rgba(239, 68, 68, 0.2)",
          }}
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="flex h-10 w-full items-center justify-center rounded-lg text-[13.5px] font-medium transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-60"
        style={{
          background: "var(--color-accent)",
          color: "#fff",
        }}
        onMouseEnter={(e) => {
          if (!submitting) (e.currentTarget as HTMLElement).style.opacity = "0.92";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.opacity = "1";
        }}
      >
        {submitting ? "Saving…" : "Continue"}
      </button>

      <p
        className="text-[11.5px]"
        style={{ color: "var(--color-text-muted)" }}
      >
        Your data stays on this device.
      </p>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-left">
      <label
        htmlFor={htmlFor}
        className="text-[11.5px] font-medium uppercase tracking-[0.06em]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}
