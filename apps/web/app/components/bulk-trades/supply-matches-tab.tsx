"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Star, X } from "lucide-react";
import type { SupplyMatchRow, SupplyMatches } from "@/lib/crm-postgres/supply-matches";
import type { BuyerSuggestion, SupplyBuyers } from "@/lib/crm-postgres/supply-buyers";
import { ErrorText, request, buttonClass, buttonStyle, inputClass, inputStyle } from "./trade-ui";
import { BusyRegion } from "./bt-shimmer";
import { rowFocus } from "./demand-page";
import { FitBadge, pct } from "./demand-supply-tab";
import css from "./demand-panel.module.css";

const listStyle = { background: "var(--bt-surface)", borderColor: "var(--bt-border)", borderRadius: 10 };

/** Buyers whose open demand fits this supply listing, the mirror of a demand's Matches tab. */
const dateOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** One CRM buyer company whose buy box fits. Verdicts are company-level; saving makes it a Candidate offer. Nothing is sent. */
function BuyerRow({ b, busy, onSave, onVerdict }: {
  b: BuyerSuggestion; busy: boolean;
  onSave: (companyId: string, personId: string | null) => void;
  onVerdict: (companyId: string, verdict: "shortlist" | "not_a_fit" | "clear", reason?: string) => void;
}) {
  const [personId, setPersonId] = useState<string>(b.contacts.find((c) => c.main && !c.optedOut)?.id ?? b.contacts.find((c) => !c.optedOut)?.id ?? "");
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const shortlisted = b.userVerdict === "shortlist";
  return (
    <li className="border-t first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
      <div className="flex items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{b.name}</span>
            {shortlisted && <span className="rounded-full border px-2 py-0.5 text-[11px] font-medium" style={{ color: "var(--bt-amber)", borderColor: "var(--bt-amber-border)" }}>Shortlisted</span>}
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
          <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-pressed={shortlisted}
            aria-label={shortlisted ? `Remove ${b.name} from shortlist` : `Shortlist ${b.name}`} title="Shortlist"
            onClick={() => onVerdict(b.companyId, shortlisted ? "clear" : "shortlist")}><Star size={14} /></button>
          <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-expanded={asking}
            aria-label={`Not a fit: ${b.name}`} title="Not a fit, with a reason"
            onClick={() => { setAsking(!asking); setReason(""); }}><X size={14} /></button>
          <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle} onClick={() => onSave(b.companyId, personId || null)}>Save as candidate</button>
        </div>
      </div>
      {asking && (
        <form className="flex flex-wrap items-center gap-2 px-4 pb-3" aria-label={`Why ${b.name} is not a fit`}
          onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { onVerdict(b.companyId, "not_a_fit", reason.trim()); } }}>
          <input aria-label={`Not a fit reason for ${b.name}`} required maxLength={200} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Why not? e.g. takes packs only, wrong market" className={`${inputClass} min-w-[220px] flex-1 text-[12px]`} style={inputStyle} />
          <button type="submit" disabled={busy || !reason.trim()} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save</button>
          <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}
            onClick={() => { setAsking(false); setReason(""); }}>Cancel</button>
        </form>
      )}
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
  async function verdict(companyId: string, value: "shortlist" | "not_a_fit" | "clear", reason?: string) {
    setBusy(true); setError(null);
    try { await request(base, { method: "POST", body: JSON.stringify({ companyId, verdict: value, ...(reason ? { reason } : {}) }) }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { setBusy(false); }
  }
  if (!data && !error) return <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Looking through buyer profiles…</p>;
  const notAFitReasons = data?.notAFitReasons ?? [];
  return (
    <section aria-label="Buyers from the CRM" className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Buyers from the CRM</h3>
      <ErrorText error={error} />
      {data && (
        <>
          <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
            Matched on each company's buy box (chemistry, format, make, origin). Shortlist keeps a company at the top; Not a fit needs a reason and hides it. Saving adds a Candidate offer; nothing is sent.
            {data.notAFit > 0 ? ` · ${data.notAFit} marked not a fit` : ""}
          </p>
          {notAFitReasons.length > 0 && (
            <details className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
              <summary className={`${rowFocus} w-fit cursor-pointer`}>Why buyers are not a fit</summary>
              <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                {notAFitReasons.map((r, i) => (
                  <li key={`${r.company}-${i}`}><span className="font-semibold">{r.company}</span>{r.reason ? `: ${r.reason}` : " (no reason recorded)"}</li>
                ))}
              </ul>
            </details>
          )}
          {data.ranked.length > 0
            ? <ul className="flex flex-col overflow-hidden border" style={listStyle}>{data.ranked.map((b) => <BuyerRow key={b.companyId} b={b} busy={busy} onSave={save} onVerdict={verdict} />)}</ul>
            : <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>No buyer you have been in touch with fits this supply.</p>}
          {data.leads.length > 0 && (
            <div className="overflow-hidden border" style={listStyle}>
              <button type="button" aria-expanded={showLeads} className={`${rowFocus} flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] font-semibold`} onClick={() => setShowLeads(!showLeads)}>
                {showLeads ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Researched leads ({data.leads.length})
                <span className="text-[11px] font-normal" style={{ color: "var(--bt-muted)" }}>found on the web, never contacted</span>
              </button>
              {showLeads && <ul className="flex flex-col border-t" style={{ borderColor: "var(--bt-border)" }}>{data.leads.map((b) => <BuyerRow key={b.companyId} b={b} busy={busy} onSave={save} onVerdict={verdict} />)}</ul>}
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
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (!active) return null;
  async function verdict(row: SupplyMatchRow, v: "shortlist" | "not_a_fit" | "clear", why?: string) {
    setBusy(true);
    setError(null);
    try {
      await request(base, { method: "POST", body: JSON.stringify({ demandId: row.demandId, verdict: v, ...(why ? { reason: why } : {}) }) });
      setReasonFor(null); setReason("");
      await load();
    }
    catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
    finally { setBusy(false); }
  }
  const notAFitReasons = data?.notAFitReasons ?? [];
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
          {notAFitReasons.length > 0 && (
            <details className="text-[12px]" style={{ color: "var(--bt-muted)" }}>
              <summary className={`${rowFocus} w-fit cursor-pointer`}>Why they are not a fit</summary>
              <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                {notAFitReasons.map((r, i) => (
                  <li key={`${r.buyer}-${i}`}><span className="font-semibold">{r.buyer}</span>{r.reason ? `: ${r.reason}` : " (no reason recorded)"}</li>
                ))}
              </ul>
            </details>
          )}
          {data.matches.length > 0 && (
            <ul className="flex flex-col overflow-hidden border" style={listStyle}>
              {data.matches.map((m) => (
                <li key={m.demandId} className="border-t first:border-t-0" style={{ borderColor: "var(--bt-border)" }}>
                  <div className="flex items-center gap-3 px-4 py-3">
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
                      <button type="button" disabled={busy} className={`${rowFocus} ${css.iconButton}`} aria-expanded={reasonFor === m.demandId}
                        aria-label="Not a fit" title="Not a fit, with a reason"
                        onClick={() => { setReasonFor(reasonFor === m.demandId ? null : m.demandId); setReason(""); }}><X size={14} /></button>
                      <button type="button" className={`${rowFocus} ${css.iconButton}`} aria-label="Open demand" title="Open demand"
                        onClick={() => onOpenListing(m.demandId)}><ExternalLink size={14} /></button>
                    </span>
                  </div>
                  {reasonFor === m.demandId && (
                    <form className="flex flex-wrap items-center gap-2 px-4 pb-3" aria-label={`Why ${m.buyer} is not a fit`}
                      onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { void verdict(m, "not_a_fit", reason.trim()); } }}>
                      <input aria-label="Not a fit reason" required maxLength={200} autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
                        placeholder="Why not? e.g. wrong chemistry, too small a lot" className={`${inputClass} min-w-[220px] flex-1 text-[12px]`} style={inputStyle} />
                      <button type="submit" disabled={busy || !reason.trim()} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}>Save</button>
                      <button type="button" disabled={busy} className={`${rowFocus} ${buttonClass}`} style={buttonStyle}
                        onClick={() => { setReasonFor(null); setReason(""); }}>Cancel</button>
                    </form>
                  )}
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
