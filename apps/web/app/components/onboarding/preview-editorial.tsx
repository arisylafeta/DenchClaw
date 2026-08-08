"use client";

import { useMemo } from "react";

/**
 * Step 1 right pane. No product mock yet — the user hasn't connected anything
 * so showing an empty People view would feel unearned. Instead: an editorial
 * pull-quote (brand-forward), a live "Welcome" card that fades the typed name
 * in, and three small bullets carrying the content that used to live on the
 * Welcome step.
 */
export function PreviewEditorial({
  typedName,
  typedEmail,
}: {
  typedName: string;
  typedEmail: string;
}) {
  const firstName = useMemo(() => {
    const trimmed = typedName.trim();
    if (!trimmed) {return "";}
    const [first] = trimmed.split(/\s+/);
    return first ?? "";
  }, [typedName]);

  const initials = useMemo(() => {
    const trimmed = typedName.trim();
    if (!trimmed) {return "";}
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
    return (first + last).toUpperCase().slice(0, 2);
  }, [typedName]);

  return (
    <div className="flex h-full w-full max-w-[520px] flex-col justify-center gap-10 px-10 py-12">
      <div>
        <p
          className="text-[11px] font-semibold uppercase tracking-[0.22em]"
          style={{ color: "var(--color-text-muted)" }}
        >
          DenchClaw
        </p>
        <p
          className="mt-4 font-instrument text-[32px] leading-[1.15] tracking-tight"
          style={{ color: "var(--color-text)" }}
        >
          A CRM that reads your inbox&nbsp;—
          <br />
          <span style={{ color: "var(--color-text-muted)" }}>
            on your machine, not ours.
          </span>
        </p>
      </div>

      <div
        className="relative rounded-2xl px-5 py-5"
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full font-instrument text-[15px] font-medium transition-all duration-300"
            style={{
              background: initials ? "var(--color-accent-fill)" : "var(--color-surface-hover)",
              color: initials ? "var(--color-accent-foreground)" : "var(--color-text-muted)",
              border: initials ? "none" : "1px dashed var(--color-border-strong)",
            }}
          >
            {initials || "·"}
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="truncate text-[13px] font-medium transition-colors"
              style={{
                color: firstName ? "var(--color-text)" : "var(--color-text-muted)",
              }}
            >
              {firstName ? `Welcome, ${firstName}.` : "Welcome,"}
            </p>
            <p
              className="mt-0.5 truncate text-[12px]"
              style={{ color: "var(--color-text-muted)" }}
            >
              {typedEmail.trim() || "Your workspace is almost ready."}
            </p>
          </div>
          <span
            aria-hidden
            className="ml-2 inline-flex h-2 w-2 shrink-0 rounded-full transition-colors duration-300"
            style={{
              background: firstName
                ? "var(--color-success)"
                : "var(--color-border-strong)",
            }}
          />
        </div>
      </div>

      <ul className="space-y-4">
        {BULLETS.map((bullet) => (
          <li key={bullet.title} className="flex gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
              style={{
                background: "var(--color-accent-light)",
                color: "var(--color-accent)",
              }}
            >
              {bullet.icon}
            </span>
            <div className="min-w-0">
              <p
                className="text-[13px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                {bullet.title}
              </p>
              <p
                className="mt-0.5 text-[12.5px] leading-relaxed"
                style={{ color: "var(--color-text-muted)" }}
              >
                {bullet.description}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const BULLETS: Array<{ title: string; description: string; icon: React.ReactNode }> = [
  {
    title: "Local-first, by design",
    description:
      "Emails and calendar events land in a DuckDB file on your laptop. Nothing leaves your machine unless you ask.",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="18" height="11" x="3" y="10" rx="2" />
        <path d="M7 10V7a5 5 0 0 1 10 0v3" />
      </svg>
    ),
  },
  {
    title: "Your strongest connections, ranked",
    description:
      "We score every relationship by recency and reciprocity. The people who matter today are always on top.",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20v-8" />
        <path d="M6 20v-4" />
        <path d="M18 20V8" />
      </svg>
    ),
  },
  {
    title: "Stays in sync, automatically",
    description:
      "Once connected, new emails and meetings flow in on their own. No refresh. No fiddling.",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 4v5h-5" />
      </svg>
    ),
  },
];
