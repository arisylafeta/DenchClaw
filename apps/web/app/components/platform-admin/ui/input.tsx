import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-base text-[var(--color-text)] transition-[border-color,box-shadow] outline-none placeholder:text-[var(--color-text-muted)] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]/20",
        "aria-invalid:border-[var(--color-error)] aria-invalid:ring-[var(--color-error)]/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
