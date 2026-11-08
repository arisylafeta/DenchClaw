import type { HTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

export type DividerVariant = "single" | "double" | "fill";
export type DividerAlign = "start" | "center" | "end";

export interface DividerProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Single hairline, two framing hairlines, or a soft filled strip. */
  variant?: DividerVariant;
  /** Places the content while the remaining line stays flexible. */
  align?: DividerAlign;
  /** Text, a button, or any compact control in the divider. */
  children?: ReactNode;
  /** Extra classes for the content wrapper. */
  contentClassName?: string;
  ref?: Ref<HTMLDivElement>;
}

const lineClass = "h-px min-w-0 flex-1 bg-[var(--color-border)]";

const withContentClass: Record<DividerVariant, string> = {
  single: "flex items-center gap-3",
  double: "flex items-center border-y border-[var(--color-border)] py-2.5",
  fill: "flex items-center rounded-lg bg-[var(--color-surface-hover)] px-4 py-2.5",
};

const emptyClass: Record<DividerVariant, string> = {
  single: "h-px bg-[var(--color-border)]",
  double: "h-2 border-y border-[var(--color-border)]",
  fill: "h-2 rounded-full bg-[var(--color-surface-hover)]",
};

const alignClass: Record<DividerAlign, string> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
};

/** Horizontal divider with BoardUI's three treatments; content stays composable. */
export function Divider({ variant = "single", align = "center", children, contentClassName, className, ref, ...props }: DividerProps) {
  const hasContent = children !== undefined && children !== null;

  if (!hasContent) {
    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation="horizontal"
        data-variant={variant}
        className={cn("w-full", emptyClass[variant], className)}
        {...props}
      />
    );
  }

  const showLeading = variant === "single" && align !== "start";
  const showTrailing = variant === "single" && align !== "end";

  return (
    <div
      ref={ref}
      data-variant={variant}
      data-align={align}
      className={cn("w-full", withContentClass[variant], alignClass[align], className)}
      {...props}
    >
      {showLeading ? <span aria-hidden className={lineClass} /> : null}
      <div className={cn("shrink-0 text-[13px] font-medium text-[var(--color-text-secondary)]", contentClassName)}>{children}</div>
      {showTrailing ? <span aria-hidden className={lineClass} /> : null}
    </div>
  );
}
