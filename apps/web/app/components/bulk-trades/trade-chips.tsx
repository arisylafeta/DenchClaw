import type { TradeGroupName } from "@/lib/bulk-trades";

export type ChipTone = "red" | "amber" | "grey";

const TONES: Record<ChipTone, React.CSSProperties> = {
  red: { background: "var(--bt-red-bg)", color: "var(--bt-red)", border: "1px solid var(--bt-red-border)" },
  amber: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)", border: "1px solid var(--bt-amber-border)" },
  grey: { background: "var(--bt-divider)", color: "var(--bt-text-2)", border: "1px solid var(--bt-grey-border)" },
};

/** Heading colour for a group of the given tone. */
export const TONE_HEADING: Record<ChipTone, string> = {
  red: "var(--bt-red)",
  amber: "var(--bt-amber)",
  grey: "var(--bt-text)",
};

export const GROUP_TONE: Record<TradeGroupName, ChipTone> = {
  Overdue: "red",
  "Due today": "amber",
  "No next step": "amber",
  "Waiting on them": "grey",
  Later: "grey",
};

export function DueChip({ label, tone }: { label: string; tone: ChipTone }) {
  return (
    <span className="whitespace-nowrap rounded-none px-2 py-0.5 text-xs font-medium" style={TONES[tone]}>
      {label}
    </span>
  );
}
