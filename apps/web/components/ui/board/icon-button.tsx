import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentType, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Square icon-only button (BoardUI `IconButton`): 32×32 with a 16px icon, or
 * 36×36 with 20px. Secondary surface only. Always labelled through `aria-label`,
 * since nothing else names it.
 */

export type IconButtonSize = "medium" | "small";

export type IconButtonIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconButtonIcon;
  size?: IconButtonSize;
  "aria-label": string;
  ref?: Ref<HTMLButtonElement>;
}

export interface IconLinkButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children"> {
  icon: IconButtonIcon;
  size?: IconButtonSize;
  "aria-label": string;
  ref?: Ref<HTMLAnchorElement>;
}

const base = [
  "relative inline-flex shrink-0 select-none items-center justify-center overflow-visible rounded-[10px]",
  "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] shadow-xs",
  "transition-[background-color,border-color,box-shadow,color] duration-150 ease",
  "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--color-accent)]",
  "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
  "disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)] disabled:opacity-60 disabled:shadow-none",
].join(" ");

const sizeClass: Record<IconButtonSize, string> = {
  medium: "size-9",
  small: "size-8",
};

const iconSize: Record<IconButtonSize, string> = {
  medium: "size-5 shrink-0",
  small: "size-4 shrink-0",
};

export function IconButton({ icon: Icon, size = "small", className, type = "button", ref, ...props }: IconButtonProps) {
  return (
    <button ref={ref} type={type} className={cn(base, sizeClass[size], className)} {...props}>
      <Icon className={iconSize[size]} aria-hidden />
    </button>
  );
}

export function IconLinkButton({ icon: Icon, size = "small", className, ref, ...props }: IconLinkButtonProps) {
  return (
    <a ref={ref} className={cn(base, sizeClass[size], className)} {...props}>
      <Icon className={iconSize[size]} aria-hidden />
    </a>
  );
}
