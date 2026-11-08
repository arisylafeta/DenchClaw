import { Check as CheckIcon, CircleHelp } from "lucide-react";

/** Exact: everything the buyer specified is confirmed. Check: it fits, but something needs a look. Never a number. */
export function FitBadge({ verdict, label = true }: { verdict: "exact" | "check"; label?: boolean }) {
  const exact = verdict === "exact";
  const text = exact ? "Exact" : "Check";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      data-verdict={verdict}
      aria-label={text}
      title={exact ? "Everything the buyer specified is confirmed" : "Fits, but something is unknown or estimated"}
      style={{
        background: exact ? "color-mix(in srgb, var(--color-success) 14%, transparent)" : "var(--color-surface-hover)",
        color: exact ? "color-mix(in srgb, var(--color-success) 58%, var(--color-text))" : "var(--color-text-secondary)",
      }}
    >
      {exact ? <CheckIcon size={12} aria-hidden /> : <CircleHelp size={12} aria-hidden />}
      {label && <span>{text}</span>}
    </span>
  );
}
