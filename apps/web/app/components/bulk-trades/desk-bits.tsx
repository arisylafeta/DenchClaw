"use client";

import { shortDate } from "@/lib/bulk-trade-details";

/** Who drives a listing, as a small initial. Alex and Ari share an A, so Ari gets "Ar". Unassigned is a dashed ring. */
const DRIVER_LOOK: Record<string, { text: string; bg: string; fg: string }> = {
  Alex: { text: "A", bg: "var(--bt-text)", fg: "var(--bt-surface)" },
  Sean: { text: "S", bg: "var(--bt-blue-bg)", fg: "var(--bt-blue)" },
  Ari: { text: "Ar", bg: "var(--bt-purple-bg)", fg: "var(--bt-purple)" },
};

export function DriverAvatar({ owner, size = 24 }: { owner: string | null | undefined; size?: number }) {
  const look = owner ? DRIVER_LOOK[owner] : undefined;
  const label = owner ? `Driver ${owner}` : "No driver";
  return (
    <span data-driver={owner ?? ""} role="img" aria-label={label} title={label}
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none"
      style={{ width: size, height: size, background: look?.bg ?? "transparent", color: look?.fg ?? "var(--bt-muted)",
        border: look ? undefined : "1px dashed var(--bt-border-strong)" }}>
      {look?.text ?? (owner ? owner.slice(0, 1) : "–")}
    </span>
  );
}

/** When a dated step is due: overdue is red, today blue, later quiet. */
export function dueTone(due: string | null | undefined, today: string): "overdue" | "today" | "later" | null {
  const day = due?.slice(0, 10);
  if (!day) return null;
  return day < today ? "overdue" : day === today ? "today" : "later";
}

const DUE_COLOR = { overdue: "var(--bt-red)", today: "var(--bt-blue)", later: "var(--bt-muted)" } as const;

export function DueText({ due, today, className = "" }: { due: string | null | undefined; today: string; className?: string }) {
  const tone = dueTone(due, today);
  if (!tone || !due) return null;
  const text = tone === "overdue" ? `Overdue · ${shortDate(due.slice(0, 10))}` : tone === "today" ? "Today" : shortDate(due.slice(0, 10));
  return <span data-due={tone} className={`text-[12px] font-semibold whitespace-nowrap tabular-nums ${className}`} style={{ color: DUE_COLOR[tone] }}>{text}</span>;
}

/** A number we should have but don't, as a quiet amber prompt ("Set %", "Add size") rather than a dash. */
export function Gap({ children }: { children: React.ReactNode }) {
  return <span data-gap className="font-medium whitespace-nowrap" style={{ color: "var(--bt-amber)" }}>{children}</span>;
}
