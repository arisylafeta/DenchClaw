"use client";

import { useState } from "react";
import { changeCounts, shortDate, ukTime, type AppliedChange } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

type Props = {
  tradeId: string;
  /** Newest first. */
  applied: AppliedChange[];
  onChanged: () => void;
};

/**
 * One line saying what the inbox check last wrote to this trade, with every change, its quote and
 * source a click away, and undo for one change or the whole run.
 */
export function InboxUpdates({ tradeId, applied, onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!applied.length) return null;

  const latestRun = applied[0].run_id;
  const latest = applied.filter((change) => change.run_id === latestRun);
  const conflicts = latest.filter((change) => change.conflict).length;
  const when = applied[0].applied_at;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not undo.");
    } finally {
      setBusy(false);
    }
  }

  const undoOne = (change: AppliedChange) => run(async () => {
    await request(`/api/bulk-trades/proposals/${change.id}`, { method: "POST", body: JSON.stringify({ action: "undo" }) });
  });

  const undoAll = () => run(async () => {
    const { refused } = await request<{ undone: number; refused: { summary: string; error: string }[] }>(
      tradeUrl(tradeId, "/applied"), { method: "POST", body: JSON.stringify({ undo_run: latestRun }) });
    if (refused.length) {
      throw new Error(`${refused.length} not undone because they changed since: ${refused.map((item) => item.summary).join("; ")}`);
    }
  });

  return (
    <section aria-label="Updated from your inbox" className="rounded-none border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
        <span className="bt-label">From your inbox</span>
        <span className="text-sm">
          Updated {shortDate(when.slice(0, 10))}, {ukTime(when)}: {changeCounts(latest)}
        </span>
        {conflicts > 0 && (
          <span className="rounded-none border px-[7px] py-px text-xs font-medium"
            style={{ background: "var(--bt-amber-bg)", color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>
            {conflicts} differ from yours, settle on Data and files
          </span>
        )}
        <span className="flex-1" />
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={`${buttonClass} h-8`} style={buttonStyle}>
          {open ? "Hide changes" : "See changes"}
        </button>
        {latest.length > 1 && latestRun && (
          <button type="button" disabled={busy} onClick={undoAll} className={`${buttonClass} h-8`} style={buttonStyle}>
            Undo all {latest.length}
          </button>
        )}
      </div>
      {error && <div className="px-5 pb-2"><ErrorText error={error} /></div>}
      {open && (
        <ul className="border-t" style={{ borderColor: "var(--bt-divider)" }}>
          {applied.map((change) => (
            <li key={change.id} className="flex flex-wrap items-start gap-3 border-b px-5 py-2.5 last:border-b-0" style={{ borderColor: "var(--bt-divider)" }}>
              <div className="min-w-[220px] flex-1">
                <div className="text-sm">
                  {change.summary}
                  {change.conflict && <span style={{ color: "var(--bt-amber)" }}> · added beside your value</span>}
                </div>
                <div className="mt-0.5 text-[13px]" style={{ color: "var(--bt-muted)" }}>
                  “{change.quote}” ·{" "}
                  {change.source_url
                    ? <a href={change.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{change.source_label}</a>
                    : change.source_label}
                  {change.source_at && ` · ${shortDate(change.source_at.slice(0, 10))}`}
                </div>
              </div>
              <button type="button" disabled={busy} onClick={() => undoOne(change)} className={`${buttonClass} h-8`} style={buttonStyle}
                aria-label={`Undo: ${change.summary}`}>
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
