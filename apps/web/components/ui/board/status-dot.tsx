import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * 12px status indicator (BoardUI `StatusDot`): a 6px solid dot on a tinted halo.
 * The dot carries the state; the halo only grounds it.
 */

export type StatusDotTone = "green" | "amber" | "red" | "neutral";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  ref?: Ref<HTMLSpanElement>;
}

const base = "inline-flex size-3 shrink-0 items-center justify-center rounded-full";

const haloClass: Record<StatusDotTone, string> = {
  green: "bg-[color-mix(in_srgb,var(--color-success)_20%,transparent)]",
  amber: "bg-[color-mix(in_srgb,var(--color-warning)_22%,transparent)]",
  red: "bg-[color-mix(in_srgb,var(--color-error)_18%,transparent)]",
  neutral: "bg-[var(--color-surface-hover)]",
};

const dotClass: Record<StatusDotTone, string> = {
  green: "bg-[var(--color-success)]",
  amber: "bg-[var(--color-warning)]",
  red: "bg-[var(--color-error)]",
  neutral: "bg-[var(--color-text-muted)]",
};

export function StatusDot({ tone = "green", className, ref, ...props }: StatusDotProps) {
  return (
    <span ref={ref} aria-hidden className={cn(base, haloClass[tone], className)} {...props}>
      <span className={cn("size-1.5 rounded-full", dotClass[tone])} />
    </span>
  );
}
