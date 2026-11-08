import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentType, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * Inline text action (BoardUI `LinkButton`): no fill, no border, an underline on
 * hover. Sized on the same scale as `Button`. Renders an anchor when `href` is
 * given, otherwise a button.
 */

export type LinkButtonVariant = "primary" | "secondary";
export type LinkButtonSize = "medium" | "small" | "xs";

export type LinkButtonIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;

interface LinkButtonBaseProps {
  variant?: LinkButtonVariant;
  size?: LinkButtonSize;
  leadingIcon?: LinkButtonIcon;
  trailingIcon?: LinkButtonIcon;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}

export interface LinkButtonAnchorProps
  extends LinkButtonBaseProps,
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "children" | "className"> {
  href: string;
  ref?: Ref<HTMLAnchorElement>;
}

export interface LinkButtonButtonProps
  extends LinkButtonBaseProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> {
  href?: undefined;
  ref?: Ref<HTMLButtonElement>;
}

export type LinkButtonProps = LinkButtonAnchorProps | LinkButtonButtonProps;

const base = [
  "inline-flex select-none items-center justify-center gap-1 whitespace-nowrap rounded-md font-sans",
  "underline-offset-3 hover:underline",
  "transition-colors duration-150 ease",
  "outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--color-accent)]",
  "disabled:cursor-not-allowed disabled:no-underline aria-disabled:cursor-not-allowed aria-disabled:no-underline",
].join(" ");

const sizeClass: Record<LinkButtonSize, string> = {
  medium: "text-[13px] font-medium",
  small: "text-[13px] font-medium",
  xs: "text-[11px] font-semibold",
};

const iconSize: Record<LinkButtonSize, string> = {
  medium: "size-5 shrink-0",
  small: "size-[18px] shrink-0",
  xs: "size-3.5 shrink-0",
};

const variantClass: Record<LinkButtonVariant, string> = {
  primary: "text-[var(--color-accent)] active:text-[var(--color-accent-hover)] disabled:text-[var(--color-text-muted)] aria-disabled:text-[var(--color-text-muted)]",
  secondary: "text-[var(--color-text-secondary)] active:text-[var(--color-text)] disabled:text-[var(--color-text-muted)] aria-disabled:text-[var(--color-text-muted)]",
};

export function LinkButton({
  variant = "primary",
  size = "medium",
  leadingIcon: Leading,
  trailingIcon: Trailing,
  children,
  className,
  disabled = false,
  ...props
}: LinkButtonProps) {
  const classes = cn(base, sizeClass[size], variantClass[variant], className);
  const content = (
    <>
      {Leading ? <Leading className={iconSize[size]} aria-hidden /> : null}
      {children !== undefined && children !== null ? <span>{children}</span> : null}
      {Trailing ? <Trailing className={iconSize[size]} aria-hidden /> : null}
    </>
  );

  if (props.href !== undefined) {
    const { ref, href, ...anchorProps } = props as LinkButtonAnchorProps;
    return (
      <a ref={ref} href={disabled ? undefined : href} aria-disabled={disabled || undefined} className={classes} {...anchorProps}>
        {content}
      </a>
    );
  }

  const { ref, type = "button", ...buttonProps } = props as LinkButtonButtonProps;
  return (
    <button ref={ref} type={type} disabled={disabled} className={classes} {...buttonProps}>
      {content}
    </button>
  );
}
