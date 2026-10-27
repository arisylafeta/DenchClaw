"use client";

import { useState } from "react";
import { request } from "./trade-ui";

/** Demand only: mark a request we can't source, with the reason. The listing's stage becomes Can't source until a deal is offered. */
export function CantSourceControl({ listingId, reason, onChanged }: { listingId: string; reason: unknown; onChanged?: () => void }) {
  const current = typeof reason === "string" && reason.trim() ? reason.trim() : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(next: string | null) {
    setBusy(true); setError(null);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/cant-source`, { method: "PUT", body: JSON.stringify({ reason: next }) });
      setEditing(false); setDraft("");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally { setBusy(false); }
  }
  const small = "h-7 rounded-md border px-2 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]";
  if (current) {
    return <span className="inline-flex max-w-[18rem] items-center gap-1.5">
      <span data-cant-source title={`Can't source: ${current}`} className="min-w-0 truncate rounded-full border px-2 py-0.5 text-[12px] font-medium"
        style={{ color: "var(--bt-red)", background: "var(--bt-red-bg)", borderColor: "var(--bt-red-border)" }}>Can&apos;t source: {current}</span>
      <button type="button" disabled={busy} onClick={() => void save(null)} className="shrink-0 text-[12px] underline" style={{ color: "var(--bt-text-2)" }}>Clear</button>
      {error && <span role="alert" className="text-[12px]" style={{ color: "var(--bt-red)" }}>{error}</span>}
    </span>;
  }
  if (editing) {
    return <form className="inline-flex items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) void save(draft); }}>
      <input autoFocus aria-label="Why we can't source it" placeholder="Reason" value={draft} maxLength={300} disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setEditing(false); } }}
        className={`${small} w-44 bg-transparent`} style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }} />
      <button type="submit" disabled={busy || !draft.trim()} className={small} style={{ borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>Save</button>
      <button type="button" onClick={() => setEditing(false)} className="text-[12px] underline" style={{ color: "var(--bt-text-2)" }}>Cancel</button>
      {error && <span role="alert" className="text-[12px]" style={{ color: "var(--bt-red)" }}>{error}</span>}
    </form>;
  }
  return <button type="button" onClick={() => { setEditing(true); setError(null); }} className={small}
    style={{ borderColor: "var(--bt-border)", color: "var(--bt-text-2)" }}>Can&apos;t source</button>;
}
