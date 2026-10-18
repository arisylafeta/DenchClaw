import type { RunCategory, ToolRunSummary } from "@/lib/hermes-chat/run-summary";

const phrases: Record<RunCategory, { past: string; present: string; noun: string }> = {
  explore: { past: "Explored", present: "Exploring", noun: "file" },
  search: { past: "Searched", present: "Searching", noun: "query" },
  run: { past: "Ran", present: "Running", noun: "command" },
  edit: { past: "Edited", present: "Editing", noun: "file" },
  fetch: { past: "Fetched", present: "Fetching", noun: "page" },
  delegate: { past: "Delegated", present: "Delegating", noun: "task" },
  other: { past: "Used", present: "Using", noun: "tool" },
};
export function toolRunPhrase(summary: ToolRunSummary): string {
  return summary.clauses.map(({ category, count }, index) => {
    const { past, noun } = phrases[category];
    const label = count === 1 ? noun : noun === "query" ? "queries" : `${noun}s`;
    return `${index ? past.toLowerCase() : past} ${count} ${label}`;
  }).join(", ") + (summary.failed ? ` · ${summary.failed} failed` : "");
}
export function liveToolPhrase(summary: ToolRunSummary): string | null {
  return summary.live ? `${phrases[summary.live.category].present} ${summary.live.target || summary.live.name}` : null;
}
