"use client";

import { useState } from "react";
import { LIKELIHOOD_OPTIONS, likelihoodOf } from "@/lib/bulk-likelihood";
import { request } from "./trade-ui";

/** Likelihood of completion (%) for a listing. It scales the deal's score. Saves on change. */
export function LikelihoodPicker({ listingId, likelihood, onChanged }: { listingId: string; likelihood: unknown; onChanged?: () => void }) {
  const [value, setValue] = useState<number | null>(likelihoodOf(likelihood));
  const [error, setError] = useState(false);
  async function change(next: string) {
    const previous = value;
    const parsed = next === "" ? null : Number(next);
    setValue(parsed); setError(false);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/likelihood`, { method: "PUT", body: JSON.stringify({ likelihood: parsed }) });
      onChanged?.();
    } catch { setValue(previous); setError(true); }
  }
  const options = value != null && !(LIKELIHOOD_OPTIONS as readonly number[]).includes(value) ? [...LIKELIHOOD_OPTIONS, value].sort((a, b) => a - b) : LIKELIHOOD_OPTIONS;
  return <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }} title="Chance this deal completes. Scales the score.">
    Likelihood
    <select aria-label="Likelihood of completion" value={value ?? ""} onChange={(event) => void change(event.target.value)}
      className="h-7 rounded-md border bg-transparent px-1.5 text-[12px]" style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }}>
      <option value="">Not set</option>
      {options.map((pct) => <option key={pct} value={pct}>{pct}%</option>)}
    </select>
  </label>;
}
