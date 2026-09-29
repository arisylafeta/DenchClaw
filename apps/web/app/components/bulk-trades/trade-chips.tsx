import type { TradeGroupName } from "@/lib/bulk-trades";

export type ChipTone = "red" | "amber" | "grey";

const TONES: Record<ChipTone, React.CSSProperties> = {
  red: { background: "rgba(217, 45, 32, 0.12)", color: "#d92d20" },
  amber: { background: "rgba(220, 104, 3, 0.12)", color: "#dc6803" },
  grey: { background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" },
};

/** Heading colour for a group of the given tone. */
export const TONE_HEADING: Record<ChipTone, string> = {
  red: "#d92d20",
  amber: "#dc6803",
  grey: "var(--color-text)",
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
