"use client";

import { useMemo } from "react";
import { Button } from "../ui/button";
import type { OnboardingState } from "@/lib/denchclaw-state";

/**
 * Full-screen landing moment shown after the user explicitly clicks "I'm
 * ready" on the sync step. No auto-redirect: the peak-end of the flow
 * deserves a beat of finality, and the user controls when they leave.
 */
export function CompleteStep({ state }: { state: OnboardingState }) {
  const firstName = useMemo(() => {
    const name = state.identity?.name?.trim() ?? "";
    if (!name) {return "";}
    return name.split(/\s+/)[0] ?? "";
  }, [state.identity?.name]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-8 py-12 text-center">
      <span
        aria-hidden
        className="relative flex h-16 w-16 items-center justify-center rounded-full"
        style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span
          aria-hidden
          className="absolute inset-0 rounded-full motion-safe:animate-[completePulse_1.8s_ease-out_infinite]"
          style={{
            boxShadow: "0 0 0 0 var(--color-accent)",
            opacity: 0.6,
          }}
        />
      </span>

      <div className="space-y-3">
        <h1
          className="font-instrument text-[40px] leading-[1.05] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          {firstName
            ? `You're all set, ${firstName}.`
            : "You're all set."}
        </h1>
        <p
          className="mx-auto max-w-md text-[15px] leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          Your workspace is ready. New email and meetings will flow in as they
          arrive — no more setup from here.
        </p>
      </div>

      <Button size="lg" onClick={() => window.location.assign("/")}>Open workspace</Button>

      <style>{`
        @keyframes completePulse {
          0%   { box-shadow: 0 0 0 0 var(--color-accent); opacity: 0.6; }
          70%  { box-shadow: 0 0 0 18px var(--color-accent); opacity: 0; }
          100% { box-shadow: 0 0 0 0 var(--color-accent); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
