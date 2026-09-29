import type { TradeGroupName } from "@/lib/bulk-trades";

export type ChipTone = "red" | "amber" | "grey";

const TONES: Record<ChipTone, React.CSSProperties> = {
  red: { background: "var(--bt-red-bg)", color: "var(--bt-red)" },
  amber: { background: "var(--bt-amber-bg)", color: "var(--bt-amber)" },
  grey: { background: "var(--bt-divider)", color: "var(--bt-text-2)" },
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
    <span className="whitespace-nowrap rounded-[5px] px-2 py-0.5 text-xs font-semibold" style={TONES[tone]}>
      {label}
    </span>
  );
}
