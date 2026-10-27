"use client";

import { useState } from "react";
import { CONVICTIONS, CONVICTION_LABEL, convictionOf } from "@/lib/bulk-conviction";
import { request } from "./trade-ui";

/** Conviction dropdown for a listing (High, Medium, Low). It scales the deal's score. Saves on change. */
export function ConvictionPicker({ listingId, conviction, onChanged }: { listingId: string; conviction: unknown; onChanged?: () => void }) {
  const [value, setValue] = useState(convictionOf(conviction));
  const [error, setError] = useState(false);
  async function change(next: string) {
    const previous = value;
    setValue(convictionOf(next)); setError(false);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/conviction`, { method: "PUT", body: JSON.stringify({ conviction: next }) });
      onChanged?.();
    } catch { setValue(previous); setError(true); }
  }
  return <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>
    Conviction
    <select aria-label="Conviction" value={value} onChange={(event) => void change(event.target.value)}
      className="h-7 rounded-md border bg-transparent px-1.5 text-[12px]" style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }}>
      {CONVICTIONS.map((c) => <option key={c} value={c}>{CONVICTION_LABEL[c].replace(" conviction", "")}</option>)}
    </select>
  </label>;
}
