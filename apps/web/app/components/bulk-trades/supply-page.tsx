"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import styles from "./bulk-detail.module.css";
import {
  SUPPLY_CLOSED_LABEL,
  SUPPLY_CLOSED_REASONS,
  sizeLabel,
  type Supply,
  type SupplyClosedReason,
} from "@/lib/bulk-supply";
import { shortDate } from "@/lib/bulk-trade-details";
import tableStyles from "../ui/data-table.module.css";
import { TableCellContent } from "../ui/table-cell";
import { Card, DetailSheet, ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, request } from "./trade-ui";


type Filter = "open" | "closed";

const COLUMNS = "grid-cols-[minmax(130px,1fr)_minmax(200px,2fr)_120px_90px]";

export function SupplyPage({ onOpenDemand, initialSupplyId }: { onOpenDemand?: (id: string) => void; initialSupplyId?: string | null }) {
  const [supply, setSupply] = useState<Supply[]>([]);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialSupplyId ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await request<{ supply: Supply[] }>("/api/bulk-trades/supply");
      setSupply(data.supply);
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
    <div className="flex min-h-0 flex-col gap-5 xl:flex-row">
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
        </div>

        <Card label="Supply" className={`bulk-trades ${tableStyles.surface} overflow-x-auto`}>
          <div className="min-w-[900px]">
            <div data-table-part="grid-header" className={`grid ${COLUMNS} gap-3.5 border-b px-3 py-2 font-medium`} style={{ background: "var(--bt-table-head)", borderColor: "var(--bt-divider)" }}>
              <span>Seller</span><span>Offers</span><span>Size</span><span>Seen</span>
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
                <TableCellContent><span className="truncate font-semibold">{row.seller}</span></TableCellContent>
                <TableCellContent><span className="truncate" title={row.offers}>{row.offers}</span></TableCellContent>
                <TableCellContent><span className="bt-mono text-xs">{sizeLabel(row) ?? "Unknown"}</span></TableCellContent>
                <TableCellContent>
                  <span className="text-xs">{row.observed_on ? shortDate(row.observed_on) : "—"}</span>
                </TableCellContent>
              </div>
            ))}
            {!shown.length && <p className="px-5 py-8 text-center text-sm" style={{ color: "var(--bt-muted)" }}>Nothing here.</p>}
          </div>
        </Card>
      </div>

      {selected && <SupplyPanel key={selected.id} supply={selected} onClose={() => setSelectedId(null)} onChanged={load} onOpenDemand={onOpenDemand} />}
    </div>
  );
}

function SupplyPanel({ supply, onClose, onChanged, onOpenDemand }: { supply: Supply; onClose: () => void; onChanged: () => void; onOpenDemand?: (id: string) => void }) {
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
    <DetailSheet title="Supply detail" onClose={onClose}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 pr-6"><h2 className="text-lg font-semibold tracking-tight">{supply.seller}</h2><span className={styles.status}>{supply.status}</span></div>
          {(supply.contact || supply.email) && (
            <div className="text-[13px]" style={{ color: "var(--bt-muted)" }}>{[supply.contact, supply.email].filter(Boolean).join(" · ")}</div>
          )}
        </div>
      </div>
      <p className="-mt-3 text-sm leading-relaxed" style={{ color: "var(--bt-muted)" }}>{supply.offers}</p>
      <dl className={styles.facts}>
        {[
          ["Quantity", supply.quantity],
          ["Size", sizeLabel(supply)],
          ["Location", supply.location],
          ["Seen", supply.observed_on ? shortDate(supply.observed_on) : null],
          ["Source", supply.source_url ? <a key="source" href={supply.source_url} target="_blank" rel="noreferrer" className="underline underline-offset-4">{supply.source_label ?? "Source"}</a> : null],
          ["Size note", supply.size_note],
        ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value || <span style={{ color: "var(--bt-muted)" }}>—</span>}</dd></div>)}
      </dl>
      {supply.source_quote && <details className="text-xs"><summary className="cursor-pointer">Source quote</summary><p className="mt-2">{supply.source_quote}</p></details>}
      <div className="flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: "var(--bt-divider)" }}>
        <h3 className="text-sm font-semibold">Buyers who fit · {supply.fits.length}</h3>
        {!supply.fits.length && <p className="text-xs" style={{ color: "var(--bt-muted)" }}>No matching buyers.</p>}
        {supply.fits.map((fit) => (
          <div key={fit.demand_id} className="flex items-center gap-2 border-b py-2" style={{ borderColor: "var(--bt-border)" }}>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium hover:underline" title={fit.reason} onClick={() => onOpenDemand?.(fit.demand_id)}><span className="truncate">{fit.buyer}</span><ArrowUpRight size={14} /></button>
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
    </DetailSheet>
  );
}
