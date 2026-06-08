"use client";

import { useState } from "react";

/**
 * "Enrich" button used in PersonProfile + CompanyProfile headers.
 *
 * v1 placeholder — calls POST /api/crm/enrich/<type>/<id>, which today
 * returns 501 deferred. UI surfaces a friendly toast either way so the
 * affordance is visible while we wire the Apollo plugin pipeline.
 */
export function EnrichButton({ type, id }: { type: "people" | "company"; id: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = async () => {
    if (busy) {return;}
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/crm/enrich/${type}/${encodeURIComponent(id)}`, {
        method: "POST",
      });
      if (res.status === 501) {
        setMessage("Enrichment coming soon — Apollo plugin pipeline still being wired up.");
      } else if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(body.error ?? `Failed (${res.status}).`);
      } else {
        const body = (await res.json()) as { status?: string };
        setMessage(
          body.status === "deferred"
            ? "Enrichment coming soon — Apollo plugin pipeline still being wired up."
            : "Enriched.",
        );
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Failed to enrich.");
    } finally {
      setBusy(false);
      setTimeout(() => setMessage(null), 4_000);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium disabled:cursor-default disabled:opacity-60"
        style={{
          background: "var(--color-surface)",
          color: "var(--color-text)",
          border: "1px solid var(--color-border)",
        }}
        title="Enrich with Apollo"
      >
        {busy ? "…" : "Enrich"}
      </button>
      {message && (
        <div
          className="absolute right-0 top-full mt-2 z-50 max-w-xs rounded-lg border px-3 py-2 text-[12px] shadow-lg"
          style={{
            background: "var(--color-surface)",
            color: "var(--color-text)",
            borderColor: "var(--color-border)",
          }}
        >
          {message}
        </div>
      )}
    </div>
  );
}
