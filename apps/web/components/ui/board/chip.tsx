import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Small coloured label (BoardUI `Chip`): status, delta and role tags.
 * Three emphases — bold (11px/500, py 2), subtle (py 4), caption (11px/500, py 4) —
 * on one 6px radius. Tones come from the DenchClaw status tokens, darkened toward
 * the text colour so every tone keeps 4.5:1 on its own tint.
 */

export type ChipVariant = "bold" | "subtle" | "caption";
export type ChipTone = "neutral" | "accent" | "green" | "amber" | "red" | "blue";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: ChipVariant;
  tone?: ChipTone;
  ref?: Ref<HTMLSpanElement>;
}

const base = "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md px-1.5 font-medium";

const variantClass: Record<ChipVariant, string> = {
  bold: "py-0.5 text-[11px] leading-4",
  subtle: "py-1 text-[11px] leading-4",
  caption: "py-1 text-[11px] leading-4 tracking-[0.15px]",
};

const toneClass: Record<ChipTone, string> = {
  neutral: "bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]",
  accent: "bg-[var(--color-accent-light)] text-[var(--color-accent)]",
  green: "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[color-mix(in_srgb,var(--color-success)_52%,var(--color-text))]",
  amber: "bg-[color-mix(in_srgb,var(--color-warning)_14%,transparent)] text-[color-mix(in_srgb,var(--color-warning)_58%,var(--color-text))]",
  red: "bg-[color-mix(in_srgb,var(--color-error)_12%,transparent)] text-[color-mix(in_srgb,var(--color-error)_62%,var(--color-text))]",
  blue: "bg-[color-mix(in_srgb,var(--color-info)_12%,transparent)] text-[color-mix(in_srgb,var(--color-info)_62%,var(--color-text))]",
};

export function Chip({ variant = "bold", tone = "neutral", className, ref, ...props }: ChipProps) {
  return <span ref={ref} className={cn(base, variantClass[variant], toneClass[tone], className)} {...props} />;
}
