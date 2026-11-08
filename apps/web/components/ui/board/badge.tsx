import type { HTMLAttributes, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Numeric counter pill (BoardUI `Badge`): nav counts and unread totals.
 * 11px/600, tracking 0, px 4, py 1, 4px radius. `primary` sits on a filled
 * surface, `neutral` on the page.
 */

export type BadgeTone = "primary" | "neutral";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  ref?: Ref<HTMLSpanElement>;
}

const base = "inline-flex items-center justify-center rounded px-1 py-px text-[11px] font-semibold leading-4 tabular-nums tracking-normal whitespace-nowrap";

const toneClass: Record<BadgeTone, string> = {
  primary: "bg-[var(--color-text)] text-[var(--color-surface)]",
  neutral: "bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]",
};

export function Badge({ tone = "neutral", className, ref, ...props }: BadgeProps) {
  return <span ref={ref} className={cn(base, toneClass[tone], className)} {...props} />;
}
