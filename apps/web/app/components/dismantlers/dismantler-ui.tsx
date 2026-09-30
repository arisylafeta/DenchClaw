"use client";

import type { Stage } from "@/lib/dismantlers";

export const dismantlerUrl = (id: string, path = "") => `/api/dismantlers/${encodeURIComponent(id)}${path}`;

const STAGE_TAG: Record<Stage, React.CSSProperties> = {
  Found: { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" },
  Talking: { background: "var(--bt-blue-bg)", color: "var(--bt-blue)", borderColor: "var(--bt-blue-border)" },
  "Signed up": { background: "var(--bt-purple-bg)", color: "var(--bt-purple)", borderColor: "var(--bt-purple-border)" },
  Live: { background: "var(--bt-green)", color: "var(--bt-surface)", borderColor: "var(--bt-green)" },
  Parked: { background: "transparent", color: "var(--bt-muted)", borderColor: "var(--bt-border)" },
};

/** Stage colour for dots and progress bars. */
export const STAGE_DOT: Record<Stage, string> = {
  Found: "#8a8a8a",
  Talking: "#3b82f6",
  "Signed up": "#8b5cf6",
  Live: "#15803d",
  Parked: "#c4c4c4",
};

export function StageTag({ stage }: { stage: Stage }) {
  return (
    <span className="whitespace-nowrap border px-2 py-0.5 text-xs font-medium" style={STAGE_TAG[stage]}>{stage}</span>
  );
}

export function StageDot({ stage }: { stage: Stage }) {
  return <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0" style={{ background: STAGE_DOT[stage] }} />;
}

export function GoalTag() {
  return (
    <span className="bt-mono shrink-0 border px-1.5 text-[10px] font-medium uppercase tracking-[0.1em]" style={{ borderColor: "var(--bt-text)" }}>
      Q4 goal
    </span>
  );
}

const TONE_TEXT = { red: "var(--bt-red)", amber: "var(--bt-amber)", grey: "var(--bt-text-2)" } as const;
export const toneText = (tone: keyof typeof TONE_TEXT) => TONE_TEXT[tone];

/** "UK · seller on eBay", skipping what is not known. */
export function metaLine(d: { country: string | null; ebay_username: string | null }) {
  return [d.country, d.ebay_username ? `${d.ebay_username} on eBay` : null].filter(Boolean).join(" · ");
}
