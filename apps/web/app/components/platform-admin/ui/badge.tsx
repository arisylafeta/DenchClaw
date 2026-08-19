import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-full border border-transparent px-2.5 py-1 text-[11px] font-medium transition-colors [&>svg]:size-3 [&>svg]:pointer-events-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/30",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-accent-fill)] text-[var(--color-accent-foreground)] [a&]:hover:bg-[var(--color-accent-fill-hover)]",
        secondary:
          "bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] [a&]:hover:text-[var(--color-text)]",
        destructive:
          "bg-[var(--color-error)] text-white [a&]:hover:opacity-90",
        outline:
          "border-[var(--color-border)] text-[var(--color-text-secondary)] [a&]:hover:bg-[var(--color-surface-hover)]",
        ghost: "text-[var(--color-text-secondary)] [a&]:hover:bg-[var(--color-surface-hover)]",
        link: "text-[var(--color-accent)] underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
