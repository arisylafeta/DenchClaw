"use client";

import { useState } from "react";
import { shortDate, type AppliedChange } from "@/lib/bulk-trade-details";
import { ErrorText, buttonClass, buttonStyle, request, tradeUrl } from "./trade-ui";

type Props = { tradeId: string; applied: AppliedChange[]; onChanged: () => void };

export function InboxUpdates({ tradeId, applied, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function undo(id?: string) {
    setBusy(true);
    setError(null);
    try {
      if (id) await request(`/api/bulk-trades/proposals/${id}`, { method: "POST", body: JSON.stringify({ action: "undo" }) });
      else {
        const result = await request<{ refused: { summary: string; error: string }[] }>(tradeUrl(tradeId, "/applied"), {
          method: "POST", body: JSON.stringify({ undo_run: applied[0].run_id }),
        });
        onChanged();
        if (result.refused.length) throw new Error(result.refused.map((item) => `${item.summary}: ${item.error}`).join("; "));
      }
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "Could not undo."); }
    finally { setBusy(false); }
  }
  return <section aria-label="Inbox changes" className="border" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
    <header className="flex items-center gap-3 px-4 py-2 text-sm font-semibold">
      <span className="flex-1">Inbox changes</span>
      {applied[0]?.run_id && <button type="button" disabled={busy} onClick={() => undo()} className={`${buttonClass} !h-7`} style={buttonStyle}>Undo latest run</button>}
    </header>
    {!applied.length && <p className="px-4 py-2 text-sm" style={{ color: "var(--bt-muted)" }}>No inbox changes.</p>}
    <ul>{applied.map((change) => <li key={change.id} className="flex items-center gap-3 border-t px-4 py-2 text-sm" style={{ borderColor: "var(--bt-divider)" }}>
      <time className="shrink-0 text-xs" style={{ color: "var(--bt-muted)" }}>{shortDate(change.applied_at.slice(0, 10))}</time>
      <span className="min-w-0 flex-1 truncate" title={change.quote}>{change.summary}{change.conflict ? " · Conflict" : ""}</span>
      {change.source_url && <a href={change.source_url} target="_blank" rel="noreferrer" className="text-xs hover:underline" style={{ color: "var(--bt-link)" }}>Source</a>}
      <button type="button" disabled={busy} onClick={() => undo(change.id)} aria-label={`Undo: ${change.summary}`} className={`${buttonClass} !h-7`} style={buttonStyle}>Undo</button>
    </li>)}</ul>
    <ErrorText error={error} />
  </section>;
}
