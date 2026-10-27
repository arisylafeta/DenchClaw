"use client";

import { useEffect, useState } from "react";
import { FEE_RATE, feeOverrideOf } from "@/lib/bulk-sheet";
import { request } from "./trade-ui";

/** Our fee (EUR) on a listing. Empty means the default, a fixed share of the value, shown as the placeholder.
 * Saves on Enter or when the field loses focus; Escape puts the saved value back. */
export function FeeInput({ listingId, fee, defaultFee, onChanged }: { listingId: string; fee: unknown; defaultFee: number | null; onChanged?: () => void }) {
  const saved = feeOverrideOf(fee);
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  const [error, setError] = useState(false);
  useEffect(() => { setDraft(saved === null ? "" : String(saved)); }, [saved]);
  async function commit() {
    const text = draft.replace(/[,\s€]/g, "");
    const next = text === "" ? null : Number(text);
    if (next !== null && (!Number.isFinite(next) || next < 0)) { setError(true); return; }
    const rounded = next === null ? null : Math.round(next);
    if (rounded === saved) { setError(false); setDraft(saved === null ? "" : String(saved)); return; }
    setError(false);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/fee`, { method: "PUT", body: JSON.stringify({ fee_eur: rounded }) });
      onChanged?.();
    } catch { setError(true); }
  }
  const hint = `Our fee in EUR. Empty uses ${FEE_RATE * 100}% of value${defaultFee != null ? ` (€${defaultFee.toLocaleString("en-GB")})` : ""}.`;
  return <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }} title={hint}>
    Fee €
    <input aria-label="Fee in euros" inputMode="numeric" value={draft} maxLength={12}
      placeholder={defaultFee != null ? defaultFee.toLocaleString("en-GB") : `${FEE_RATE * 100}%`}
      onChange={(event) => { setDraft(event.target.value); setError(false); }}
      onBlur={() => void commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); void commit(); }
        if (event.key === "Escape") { event.preventDefault(); setDraft(saved === null ? "" : String(saved)); setError(false); }
      }}
      className="h-7 w-20 rounded-md border bg-transparent px-1.5 text-[12px] tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
      style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }} />
  </label>;
}
