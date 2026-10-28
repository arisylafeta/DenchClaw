"use client";

import { useState } from "react";
import { DEAL_OWNERS, dealOwner } from "@/lib/bulk-owner";
import { request } from "./trade-ui";

/** Deal owner dropdown for a listing: Sean, Alex or Ari. Saves on change. */
export function OwnerPicker({ listingId, owner, onChanged }: { listingId: string; owner: unknown; onChanged?: () => void }) {
  const [value, setValue] = useState(dealOwner(owner) ?? "");
  const [error, setError] = useState(false);
  async function change(next: string) {
    const previous = value;
    setValue(next as typeof value); setError(false);
    try {
      await request(`/api/bulk-listings/${encodeURIComponent(listingId)}/owner`, { method: "PUT", body: JSON.stringify({ owner: next || null }) });
      onChanged?.();
    } catch { setValue(previous); setError(true); }
  }
  return <label className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: "var(--bt-muted)" }}>
    Driver
    <select aria-label="Deal owner" value={value} onChange={(event) => void change(event.target.value)}
      className="h-7 rounded-md border bg-transparent px-1.5 text-[12px]" style={{ borderColor: error ? "var(--bt-red)" : "var(--bt-border)", color: "var(--bt-text)" }}>
      <option value="">No driver</option>
      {DEAL_OWNERS.map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
  </label>;
}
