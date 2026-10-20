import { Loading } from "../ui/shimmer";
"use client";

import { type ReactNode } from "react";

/**
 * Standard shell for the CRM top-level views (People / Companies / Inbox /
 * Calendar). Provides a consistent header (title, actions, search slot)
 * and a scrollable body. Reused by every list view so they look uniform.
 */
export function CrmListShell({
  title,
  count,
  toolbar,
  children,
}: {
  title: string;
  count?: number | null;
  /** Right-aligned slot for filters/sort/search affordances. */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ background: "var(--color-background)" }}
    >
      <header
        className="flex shrink-0 items-center justify-between gap-4 px-6 py-3"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <div className="min-w-0 flex items-baseline gap-3">
          <h1
            className="font-instrument text-xl tracking-tight truncate"
            style={{ color: "var(--color-text)" }}
          >
            {title}
          </h1>
          {typeof count === "number" && (
            <span
              className="text-[12px]"
              style={{ color: "var(--color-text-muted)" }}
            >
              {count.toLocaleString()}
            </span>
          )}
        </div>
        {toolbar && <div className="flex items-center gap-2 shrink-0">{toolbar}</div>}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </div>
  );
}

export function CrmEmptyState({
  title,
  description,
  cta,
}: {
  title: string;
  description?: string;
  cta?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 px-8 py-16 text-center">
      <h2
        className="font-instrument text-2xl tracking-tight"
        style={{ color: "var(--color-text)" }}
      >
        {title}
      </h2>
      {description && (
        <p
          className="text-sm max-w-md leading-relaxed"
          style={{ color: "var(--color-text-muted)" }}
        >
          {description}
        </p>
      )}
      {cta}
    </div>
  );
}

export function CrmLoadingState({ label = "Loading…", variant = "rows" }: { label?: string; variant?: "rows" | "cards" | "chat" | "detail" | "table" }) {
  return <Loading label={label} variant={variant} />;
}
