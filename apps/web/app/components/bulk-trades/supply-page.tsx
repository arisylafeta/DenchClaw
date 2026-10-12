"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  SUPPLY_CLOSED_LABEL,
  SUPPLY_CLOSED_REASONS,
  sizeLabel,
  type Supply,
  type SupplyClosedReason,
} from "@/lib/bulk-supply";
import { shortDate, ukTime } from "@/lib/bulk-trade-details";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import { DemandBadge } from "./demand-badge";
import { Card, ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request } from "./trade-ui";

/** The latest supply-matching pass. */
type MatchRun = { at: string; status: "running" | "ok" | "failed" };

type Filter = "open" | "closed";

const COLUMNS = "grid-cols-[minmax(160px,1fr)_minmax(260px,2.2fr)_120px_110px_90px_minmax(140px,1fr)]";

/**
 * Reuse batches the inbox check found that are too small for a card (under about 8 tonnes and $10k) or of unknown
 * size, with the buyers whose open demand fits each one.
 */
export function SupplyPage() {
  const [supply, setSupply] = useState<Supply[]>([]);
  const [matched, setMatched] = useState<MatchRun | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<{ supply: Supply[]; matched?: MatchRun | null }>("/api/bulk-trades/supply");
      setSupply(data.supply);
      setMatched(data.matched ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load supply.");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const open = supply.filter((row) => row.status === "open");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = supply.filter((row) => row.status === filter);
    return needle ? rows.filter((row) => `${row.seller} ${row.contact ?? ""} ${row.offers} ${row.location ?? ""}`
      .toLowerCase().includes(needle)) : rows;
  }, [supply, filter, query]);
  const selected = supply.find((row) => row.id === selectedId) ?? null;

  const segment = (value: Filter, label: string) => (
    <button type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
      className="h-8 px-3 text-xs font-medium"
      style={filter === value ? { background: "var(--bt-badge)", color: "var(--bt-on-badge)" } : { background: "var(--bt-surface)", color: "var(--bt-text)" }}>
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-5">
        <ErrorText error={error} />
        <div data-table-part="toolbar" className={`bulk-trades ${tableStyles.surface} flex flex-wrap items-center gap-3 border`}>
          <div role="group" aria-label="Filter" className="flex border" style={{ borderColor: "var(--bt-border)" }}>
            {segment("open", `Open ${open.length}`)}
            {segment("closed", "Closed")}
          </div>
          <input data-table-part="search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search supply"
            placeholder="Search sellers or batches" className="h-8 w-full max-w-[340px] rounded-none border px-2.5 text-xs"
            style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }} />
          <span className="flex-1" />
          <span className="text-[13px]" style={{ color: "var(--bt-muted)" }}>Reuse batches under 8 t and $10k, or size unknown</span>
          {matched && (
            <span className="text-[13px]" style={{ color: matched.status === "failed" ? "var(--bt-red)" : "var(--bt-muted)" }}>
              {matched.status === "failed" ? "Matching failed" : matched.status === "running" ? "Matching now" : "Matched"} {ukTime(matched.at)}
            </span>
          )}
        </div>

        <Card label="Supply" className={`bulk-trades ${tableStyles.surface} overflow-x-auto`}>
          <div className="min-w-[900px]">
            <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-3.5 border-b px-3 py-2 font-medium`} style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
              <span>Seller</span><span>Offers</span><span>Size (est.)</span><span>Where</span><span>Seen</span><span>Buyers who fit</span>
            </div>
            {shown.map((row) => (
              <div key={row.id} data-table-part="grid-row" role="button" tabIndex={0} onClick={() => setSelectedId(row.id)} aria-pressed={row.id === selectedId}
                onKeyDown={(event) => {
                  if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    setSelectedId(row.id);
                  }
                }}
                className={`grid w-full ${COLUMNS} items-center gap-3.5 border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-[var(--bt-row-hover)]`}
                style={{ borderColor: "var(--bt-divider)", color: row.status === "closed" ? "var(--bt-muted)" : "var(--bt-text)",
                  background: row.id === selectedId ? "var(--bt-row-hover)" : undefined }}>
                <TableCellContent>
                  <div className="flex min-w-0 flex-col items-start gap-0.5">
                    <div className="max-w-full truncate text-xs font-semibold">{row.seller}</div>
                    {row.contact && <div className="max-w-full truncate text-xs" style={{ color: "var(--bt-muted)" }}>{row.contact}</div>}
                  </div>
                </TableCellContent>
                <TableCellContent>
                  <span className="flex flex-col gap-0.5 text-xs leading-snug">
                    {row.offers}
                    {row.quantity && <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{row.quantity}</span>}
                  </span>
                </TableCellContent>
                <TableCellContent><span className="bt-mono text-xs">{sizeLabel(row) ?? "Unknown"}</span></TableCellContent>
                <TableCellContent><span className="text-xs">{row.location ?? ""}</span></TableCellContent>
                <TableCellContent>
                  <span className="flex flex-col items-start gap-1 text-xs">
                    {row.observed_on ? shortDate(row.observed_on) : ""}
                    {row.status === "closed" && row.closed_reason && <span className="text-xs">{SUPPLY_CLOSED_LABEL[row.closed_reason]}</span>}
                  </span>
                </TableCellContent>
                <TableCellContent>
                  <span className="text-xs" style={{ color: row.fits.length ? "var(--bt-link)" : "var(--bt-muted)" }}>
                    {row.fits.length ? row.fits.map((fit) => fit.buyer).join(" · ") : "—"}
                  </span>
                </TableCellContent>
              </div>
            ))}
            {!shown.length && <p className="px-5 py-8 text-center text-sm" style={{ color: "var(--bt-muted)" }}>Nothing here.</p>}
          </div>
        </Card>
      </div>

      {selected && <SupplyPanel key={selected.id} supply={selected} onClose={() => setSelectedId(null)} onChanged={load} />}
    </div>
  );
}

function SupplyPanel({ supply, onClose, onChanged }: { supply: Supply; onClose: () => void; onChanged: () => void }) {
  const [closing, setClosing] = useState(false);
  const [reason, setReason] = useState<SupplyClosedReason>("gone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: object) {
    setBusy(true);
    setError(null);
    try {
      await request(`/api/bulk-trades/supply/${encodeURIComponent(supply.id)}`, { method: "PATCH", body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside aria-label="Supply detail" className="flex w-[380px] shrink-0 flex-col gap-4 self-start rounded-none border p-5"
      style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <span className="bt-label">Supply</span>
          <h2 className="mt-1 text-lg font-semibold">{supply.seller}</h2>
          {(supply.contact || supply.email) && (
            <div className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{[supply.contact, supply.email].filter(Boolean).join(" · ")}</div>
          )}
        </div>
        <button type="button" onClick={onClose} className="text-sm" style={{ color: "var(--bt-muted)" }}>Close</button>
      </div>
      <p className="text-[15px] leading-snug">{supply.offers}</p>
      <dl className="grid grid-cols-[110px_1fr] gap-y-1.5 text-sm">
        <dt style={{ color: "var(--bt-muted)" }}>Quantity</dt><dd>{supply.quantity ?? "—"}</dd>
        <dt style={{ color: "var(--bt-muted)" }}>Size (est.)</dt>
        <dd>{sizeLabel(supply) ?? "Unknown"}{supply.size_note ? <span style={{ color: "var(--bt-muted)" }}> · {supply.size_note}</span> : null}</dd>
        <dt style={{ color: "var(--bt-muted)" }}>Where</dt><dd>{supply.location ?? "—"}</dd>
        {supply.source_label && (<>
          <dt style={{ color: "var(--bt-muted)" }}>Source</dt>
          <dd>{supply.source_url
            ? <a href={supply.source_url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--bt-link)" }}>{supply.source_label}</a>
            : supply.source_label}{supply.observed_on ? `, ${shortDate(supply.observed_on)}` : ""}</dd>
        </>)}
      </dl>
      {supply.source_quote && (
        <p className="border-t pt-3 text-[13px]" style={{ borderColor: "var(--bt-divider)", color: "var(--bt-text-2)" }}>“{supply.source_quote}”</p>
      )}
      <div className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h3 className="text-sm font-semibold">Buyers who fit</h3>
        {!supply.fits.length && <p className="text-[13px]" style={{ color: "var(--bt-muted)" }}>No open demand fits yet. Matching runs with each inbox check.</p>}
        {supply.fits.map((fit) => (
          <div key={fit.demand_id} className="flex flex-col gap-1.5 rounded-none border px-3 py-2.5" style={{ borderColor: "var(--bt-border)" }}>
            <div className="flex items-center gap-2">
              <span className="flex-1 text-sm font-semibold">{fit.buyer}</span>
              <DemandBadge kind={fit.kind} basis={fit.basis} />
              <span className="rounded-none border px-1.5 py-px text-xs font-medium"
                style={fit.strength === "strong"
                  ? { background: "var(--bt-green-bg)", color: "var(--bt-green)", borderColor: "var(--bt-green-border)" }
                  : { background: "var(--bt-divider)", color: "var(--bt-text-2)", borderColor: "var(--bt-grey-border)" }}>
                {fit.strength === "strong" ? "Strong" : "Partial"}
              </span>
            </div>
            <span className="text-[13px]" style={{ color: "var(--bt-text-2)" }}>{fit.reason}</span>
            {(fit.contact || fit.email) && (
              <span className="text-xs" style={{ color: "var(--bt-muted)" }}>{[fit.contact, fit.email].filter(Boolean).join(" · ")}</span>
            )}
            <button type="button" disabled={busy} className={`${buttonClass} h-8 self-start`} style={buttonStyle}
              onClick={() => patch({ action: "hide_fit", demand_id: fit.demand_id })}>
              Not a fit
            </button>
          </div>
        ))}
      </div>
      <ErrorText error={error} />
      {supply.status === "closed" ? (
        <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <button type="button" disabled={busy} className={`${darkButtonClass} h-9`} style={darkButtonStyle}
            onClick={() => patch({ action: "reopen" })}>Reopen</button>
        </div>
      ) : closing ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <label className="sr-only" htmlFor={`close-${supply.id}`}>Why</label>
          <select id={`close-${supply.id}`} value={reason} onChange={(event) => setReason(event.target.value as SupplyClosedReason)}
            className="h-9 rounded-none border px-2 text-sm" style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" }}>
            {SUPPLY_CLOSED_REASONS.map((value) => <option key={value} value={value}>{SUPPLY_CLOSED_LABEL[value]}</option>)}
          </select>
          <button type="button" disabled={busy} className={`${darkButtonClass} h-9`} style={darkButtonStyle}
            onClick={async () => { await patch({ action: "close", reason }); setClosing(false); }}>Close batch</button>
          <button type="button" onClick={() => setClosing(false)} className={`${buttonClass} h-9`} style={buttonStyle}>Cancel</button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
          <button type="button" onClick={() => setClosing(true)} className={`${buttonClass} h-9`} style={buttonStyle}>Close…</button>
        </div>
      )}
    </aside>
  );
}
