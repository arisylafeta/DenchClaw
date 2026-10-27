"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Star, X } from "lucide-react";
import type { SupplyMatchRow, SupplyMatches } from "@/lib/crm-postgres/supply-matches";
import { BusyRegion } from "./bt-shimmer";
import { rowFocus } from "./demand-page";
import { FitBadge, pct } from "./demand-supply-tab";
import { ErrorText, request } from "./trade-ui";
import css from "./demand-panel.module.css";

const listStyle = { background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 };

/** Buyers whose open demand fits this supply listing, the mirror of a demand's Matches tab. */
export function SupplyMatchesTab({ listingId, active, onOpenListing }: { listingId: string; active: boolean; onOpenListing: (id: string) => void }) {
  const base = `/api/bulk-listings/${encodeURIComponent(listingId)}/matches`;
  const [data, setData] = useState<SupplyMatches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await request<SupplyMatches>(base)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load matches."); }
  }, [base]);
  useEffect(() => { if (active) void load(); }, [active, load]);
  if (!active) return null;
  async function verdict(row: SupplyMatchRow, v: "shortlist" | "not_a_fit" | "clear") {
    setBusy(true);
    try { await request(base, { method: "POST", body: JSON.stringify({ demandId: row.demandId, verdict: v }) }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { setBusy(false); }
  }
  const loading = data === null && !error;
  return (
    <BusyRegion busy={loading} label="Finding buyers" className="flex w-full min-w-0 flex-col gap-3">
      <ErrorText error={error} />
      {data?.blocked && <p className={css.empty}>{data.blocked}</p>}
      {data && !data.blocked && (
        <>
          <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
            {data.matches.length ? `${data.matches.length} open ${data.matches.length === 1 ? "demand fits" : "demands fit"} this supply` : "No open demand fits this supply yet."}
            {data.notAFit > 0 && ` · ${data.notAFit} marked not a fit`}
          </p>
          {data.matches.length > 0 && (
            <ul className="flex flex-col overflow-hidden border" style={listStyle}>
              {data.matches.map((m) => (
                <li key={m.demandId} className="flex items-center gap-3 border-t px-4 py-3 first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
                  <FitBadge verdict={m.verdict} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold">{m.buyer}</div>
                    <div className="truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>
                      {[m.title, m.quantity, m.location].filter(Boolean).join(" · ")}
                    </div>
                    {(m.gap || m.saved) && (
                      <div className="truncate text-[12px]" style={{ color: "var(--bt-muted)" }}>
                        {m.gap ? `Check: ${m.gap}` : null}{m.saved ? `${m.gap ? " · " : ""}Saved match: ${m.saved.reason || m.saved.strength}` : null}
                        {m.marginPct != null ? ` · ${pct(m.marginPct)} margin` : ""}
                      </div>
                    )}
                  </div>
                  <span className="inline-flex gap-1">
                    <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-pressed={m.userVerdict === "shortlist"}
                      aria-label={m.userVerdict === "shortlist" ? "Remove from shortlist" : "Shortlist"} title="Shortlist"
                      onClick={() => void verdict(m, m.userVerdict === "shortlist" ? "clear" : "shortlist")}><Star size={14} /></button>
                    <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-label="Not a fit" title="Not a fit"
                      onClick={() => void verdict(m, "not_a_fit")}><X size={14} /></button>
                    <button type="button" className={`${rowFocus} ${css.iconButton}`} aria-label="Open demand" title="Open demand"
                      onClick={() => onOpenListing(m.demandId)}><ExternalLink size={14} /></button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </BusyRegion>
  );
}
