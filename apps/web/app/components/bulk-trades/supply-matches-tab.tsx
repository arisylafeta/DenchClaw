"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Star, X } from "lucide-react";
import type { SupplyMatchRow, SupplyMatches } from "@/lib/crm-postgres/supply-matches";
import type { BuyerSuggestion, SupplyBuyers } from "@/lib/crm-postgres/supply-buyers";
import { buttonClass, buttonStyle } from "./trade-ui";
import { BusyRegion } from "./bt-shimmer";
import { rowFocus } from "./demand-page";
import { FitBadge, pct } from "./demand-supply-tab";
import { ErrorText, request } from "./trade-ui";
import css from "./demand-panel.module.css";

const listStyle = { background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 };

/** Buyers whose open demand fits this supply listing, the mirror of a demand's Matches tab. */
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** One CRM buyer company whose buy box fits. Saving makes it a Candidate offer; nothing is sent. */
function BuyerRow({ b, busy, onSave }: { b: BuyerSuggestion; busy: boolean; onSave: (companyId: string, personId: string | null) => void }) {
  const [personId, setPersonId] = useState<string>(b.contacts.find((c) => c.main && !c.optedOut)?.id ?? b.contacts.find((c) => !c.optedOut)?.id ?? "");
  return (
    <li className="flex items-start gap-3 border-t px-4 py-3 first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold">{b.name}</span>
          <span className="text-[11px]" style={{ color: "var(--bt-muted)" }}>
            {[b.stage ?? "No stage", b.basis === "stated" ? "stated by the buyer" : "researched, not yet contacted", b.tier ? `tier ${b.tier}` : null].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="text-[12px]">Matches: {b.fit.matched.join(", ")}</div>
        {b.fit.gaps.length > 0 && <div className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Check: {b.fit.gaps.join("; ")}</div>}
        <div className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
          {b.lastTouch ? `Last contact ${dateOf(b.lastTouch)}` : "No email on record"}{b.wants ? ` · ${b.wants}` : ""}
        </div>
        {b.contacts.length > 0 && (
          <div className="mt-1 text-[12px]" style={{ color: "var(--bt-muted)" }}>
            {b.contacts.slice(0, 3).map((c) => `${c.name ?? c.email ?? "Unnamed"}${c.jobTitle ? ` (${c.jobTitle})` : ""}${c.main ? " · main" : ""}${c.optedOut ? " · opted out" : ""}`).join(" · ")}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {b.contacts.length > 1 && (
          <select aria-label={`Contact at ${b.name}`} value={personId} onChange={(e) => setPersonId(e.target.value)} className="border px-2 py-1 text-[12px]" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
            {b.contacts.filter((c) => !c.optedOut).map((c) => <option key={c.id} value={c.id}>{c.name ?? c.email ?? "Unnamed"}</option>)}
          </select>
        )}
        <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => onSave(b.companyId, personId || null)}>Save as candidate</button>
      </div>
    </li>
  );
}

function BuyerSuggestions({ base, onSaved }: { base: string; onSaved: () => void }) {
  const [data, setData] = useState<SupplyBuyers | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLeads, setShowLeads] = useState(false);
  const load = useCallback(async () => {
    try { setData(await request<SupplyBuyers>(base)); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load buyers."); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);
  async function save(companyId: string, personId: string | null) {
    setBusy(true);
    try { await request(base, { method: "POST", body: JSON.stringify({ companyId, personId }) }); await load(); onSaved(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { setBusy(false); }
  }
  if (!data && !error) return <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Looking through buyer profiles…</p>;
  return (
    <section aria-label="Buyers from the CRM" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Buyers from the CRM</h3>
      <ErrorText error={error} />
      {data && (
        <>
          <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
            Matched on each company's buy box (chemistry, format, make, origin). Saving adds a Candidate offer; nothing is sent.
          </p>
          {data.ranked.length > 0
            ? <ul className="flex flex-col overflow-hidden border" style={listStyle}>{data.ranked.map((b) => <BuyerRow key={b.companyId} b={b} busy={busy} onSave={save} />)}</ul>
            : <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>No buyer you have been in touch with fits this supply.</p>}
          {data.leads.length > 0 && (
            <div className="overflow-hidden border" style={listStyle}>
              <button type="button" aria-expanded={showLeads} className={`${rowFocus} flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] font-semibold`} onClick={() => setShowLeads(!showLeads)}>
                {showLeads ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Researched leads ({data.leads.length})
                <span className="text-[11px] font-normal" style={{ color: "var(--bt-muted)" }}>found on the web, never contacted</span>
              </button>
              {showLeads && <ul className="flex flex-col border-t" style={{ borderColor: "var(--bt-border)" }}>{data.leads.map((b) => <BuyerRow key={b.companyId} b={b} busy={busy} onSave={save} />)}</ul>}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function SupplyMatchesTab({ listingId, active, onOpenListing, onSaved = () => {} }: { listingId: string; active: boolean; onOpenListing: (id: string) => void; onSaved?: () => void }) {
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
      <BuyerSuggestions base={`/api/bulk-listings/${encodeURIComponent(listingId)}/buyers`} onSaved={onSaved} />
    </BusyRegion>
  );
}
