"use client";

import { useEffect, useRef, useState } from "react";
import { FEE_RATE, feeOverrideOf } from "@/lib/bulk-sheet";
import { request } from "./trade-ui";

/**
 * A typed fee in whole euros, or null for empty. Commas, spaces and € are ignored. A dot followed by exactly three
 * digits is a thousands separator ("10.000" is 10,000), never a decimal point, so it never saves €10. Anything else
 * that is not a number of 0 or more is undefined (refused).
 */
export function parseFee(text: string): number | null | undefined {
  const clean = text.replace(/[,\s€]/g, "");
  if (clean === "") return null;
  const digits = /^\d{1,3}(\.\d{3})+$/.test(clean) ? clean.replace(/\./g, "") : clean;
  const value = Number(digits);
  return /^\d+(\.\d+)?$/.test(digits) && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Our fee (EUR) on a listing. Empty means the default, a fixed share of the value, shown as the placeholder.
 * Saves on Enter or when the field loses focus, once; Escape puts the saved value back. */
export function FeeInput({ listingId, fee, defaultFee, onChanged }: { listingId: string; fee: unknown; defaultFee: number | null; onChanged?: () => void }) {
  const saved = feeOverrideOf(fee);
  const [draft, setDraft] = useState(saved === null ? "" : String(saved));
  const [error, setError] = useState<string | null>(null);
  // What the server holds as far as this field knows, and whether a save is under way: Enter then blur saves once.
  const stored = useRef(saved);
  const saving = useRef(false);
  useEffect(() => { stored.current = saved; setDraft(saved === null ? "" : String(saved)); }, [saved]);
  async function commit() {
    const next = parseFee(draft);
    if (next === undefined) { setError("Enter a number of euros"); return; }
    if (next === stored.current) { setError(null); setDraft(next === null ? "" : String(next)); return; }
    if (saving.current) return;
    saving.current = true;
    setError(null);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/fee`, { method: "PUT", body: JSON.stringify({ fee_eur: next }) });
      stored.current = next;
      setDraft(next === null ? "" : String(next));
      onChanged?.();
    } catch {
      setError("Could not save the fee");
    } finally {
      saving.current = false;
    }
  }
  const hint = `Our fee in EUR. Empty uses ${FEE_RATE * 100}% of value${defaultFee != null ? ` (€${defaultFee.toLocaleString("en-GB")})` : ""}.`;
  return <span className="inline-flex flex-col items-start gap-0.5">
    <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }} title={hint}>
      Fee €
      <input aria-label="Fee in euros" inputMode="numeric" value={draft} maxLength={14} aria-invalid={error ? true : undefined}
        aria-describedby={error ? `fee-error-${listingId}` : undefined}
        placeholder={defaultFee != null ? defaultFee.toLocaleString("en-GB") : `${FEE_RATE * 100}%`}
        onChange={(event) => { setDraft(event.target.value); setError(null); }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); void commit(); }
          if (event.key === "Escape") { event.preventDefault(); setDraft(stored.current === null ? "" : String(stored.current)); setError(null); }
        }}
        className="h-7 w-20 rounded-md border bg-transparent px-1.5 text-[12px] tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--bt-text-2)]"
        style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }} />
    </label>
    {error && <span id={`fee-error-${listingId}`} role="alert" className="text-[11px]" style={{ color: "var(--bt-red)" }}>{error}</span>}
  </span>;
}
