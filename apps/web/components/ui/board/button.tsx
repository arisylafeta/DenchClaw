import type { ButtonHTMLAttributes, ComponentType, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Container button (BoardUI `Button`), on DenchClaw tokens.
 *
 *            container                icon   text
 *   medium   36 high, p 8, radius 10  20     13px/500
 *   small    32 high, px 8 py 6, r 8  18     13px/500
 *   xs       24 high, px 8, r 6       14     11px/600
 *
 * One primary action per area: `secondary` and `ghost` are for quiet actions.
 * Icons are passed as components so the size stays consistent, and never as
 * elements with their own width.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "medium" | "small" | "xs";

export type ButtonIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  leadingIcon?: ButtonIcon;
  trailingIcon?: ButtonIcon;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

const base = [
  "inline-flex select-none items-center justify-center gap-0.5 overflow-hidden whitespace-nowrap font-sans",
  "transition-[background-color,border-color,color,box-shadow] duration-150 ease",
  "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--color-accent)]",
  "disabled:cursor-not-allowed aria-disabled:cursor-not-allowed",
].join(" ");

const sizeClass: Record<ButtonSize, string> = {
  medium: "h-9 rounded-[10px] p-2 text-[13px] font-medium",
  small: "h-8 rounded-lg px-2 py-1.5 text-[13px] font-medium",
  xs: "h-6 rounded-md px-2 text-[11px] font-semibold",
};

const iconOnlySize: Record<ButtonSize, string> = {
  medium: "w-9 px-0",
  small: "w-8 px-0",
  xs: "w-6 px-0",
};

const iconSize: Record<ButtonSize, string> = {
  medium: "size-5 shrink-0",
  small: "size-[18px] shrink-0",
  xs: "size-3.5 shrink-0",
};

const labelClass: Record<ButtonSize, string> = {
  medium: "inline-flex shrink-0 items-center justify-center px-1",
  small: "inline-flex shrink-0 items-center justify-center px-0.5",
  xs: "inline-flex shrink-0 items-center justify-center px-0.5",
};

const variantClass: Record<ButtonVariant, string> = {
  primary: [
    "bg-[var(--color-accent-fill)] text-[var(--color-accent-foreground)] shadow-xs",
    "hover:bg-[var(--color-accent-fill-hover)]",
    "disabled:bg-[var(--color-surface-hover)] disabled:text-[var(--color-text-muted)] disabled:shadow-none",
  ].join(" "),
  secondary: [
    "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-xs",
    "hover:bg-[var(--color-surface-hover)]",
    "disabled:bg-[var(--color-surface-hover)] disabled:text-[var(--color-text-muted)] disabled:shadow-none",
  ].join(" "),
  ghost: [
    "bg-transparent text-[var(--color-text-secondary)]",
    "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
    "disabled:text-[var(--color-text-muted)]",
  ].join(" "),
  danger: [
    "bg-[var(--color-error)] text-white shadow-xs",
    "hover:bg-[color-mix(in_srgb,var(--color-error)_86%,black)]",
    "disabled:bg-[var(--color-surface-hover)] disabled:text-[var(--color-text-muted)] disabled:shadow-none",
  ].join(" "),
};

export function Button({
  variant = "primary",
  size = "medium",
  iconOnly = false,
  leadingIcon: Leading,
  trailingIcon: Trailing,
  children,
  className,
  type = "button",
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(base, sizeClass[size], variantClass[variant], iconOnly && iconOnlySize[size], className)}
      {...props}
    >
      {Leading ? <Leading className={iconSize[size]} aria-hidden /> : null}
      {!iconOnly && children !== undefined && children !== null ? <span className={labelClass[size]}>{children}</span> : null}
      {!iconOnly && Trailing ? <Trailing className={iconSize[size]} aria-hidden /> : null}
    </button>
  );
}
