"use client";

import { useState } from "react";
import { needText, type DemandLine } from "@/lib/demand-lines";
import { ErrorText, buttonClass, buttonStyle, darkButtonClass, darkButtonStyle, inputClass, inputStyle, request } from "./trade-ui";
import { rowFocus } from "./demand-page";

/** A line as the form holds it: the lists as comma-separated text, the numbers as typed. */
type Draft = { id: string; label: string; products: string; kwh: string; qty_min: string; qty_max: string };
const toDraft = (line: DemandLine): Draft => ({
  id: line.id, label: line.label, products: line.products.join(", "), kwh: line.kwh.join(", "), qty_min: String(line.qty_min), qty_max: line.qty_max ? String(line.qty_max) : "",
});
const blank = (): Draft => ({ id: "", label: "", products: "", kwh: "", qty_min: "", qty_max: "" });
const list = (text: string) => text.split(",").map((part) => part.trim()).filter(Boolean);

/**
 * The buyer's pack types on a request, each with how many: what Group matches counts stock against. Read as a short
 * table; Edit opens a row per type. The server checks every value (lib/demand-lines.ts) and says what is wrong.
 */
export function DemandLinesEditor({ demandId, lines, onSaved }: { demandId: string; lines: DemandLine[]; onSaved: () => void }) {
  const [rows, setRows] = useState<Draft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!rows) return;
    setBusy(true); setError(null);
    try {
      const body = rows.filter((row) => row.label.trim() || row.qty_min.trim()).map((row) => ({
        ...(row.id ? { id: row.id } : {}),
        label: row.label, products: list(row.products), kwh: list(row.kwh).map(Number), qty_min: Number(row.qty_min), qty_max: row.qty_max.trim() ? Number(row.qty_max) : null,
      }));
      await request(`/api/bulk-trades/demand/${encodeURIComponent(demandId)}/lines`, { method: "PUT", body: JSON.stringify({ lines: body }) });
      setRows(null);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the pack types.");
    } finally {
      setBusy(false);
    }
  }
  const set = (i: number, key: keyof Draft, value: string) => setRows((current) => current && current.map((row, k) => (k === i ? { ...row, [key]: value } : row)));

  return (
    <section aria-label="Pack types" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Pack types <span className="font-normal" style={{ color: "var(--bt-muted)" }}>· how many of each the buyer wants</span></h3>
        {!rows && (
          <button type="button" className={`${rowFocus} text-[12px] font-semibold`} style={{ color: "var(--bt-link)" }} onClick={() => setRows(lines.length ? lines.map(toDraft) : [blank(), blank()])}>
            {lines.length ? "Edit" : "Add pack types"}
          </button>
        )}
      </div>
      {!rows && (lines.length ? (
        <ul className="flex flex-col border text-[13px]" style={{ borderColor: "var(--bt-border)", background: "var(--bt-surface)" }}>
          {lines.map((line) => (
            <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t px-3 py-2 first:border-t-0" style={{ borderColor: "var(--bt-divider)" }}>
              <span className="font-medium">{line.label}</span>
              <span style={{ color: "var(--bt-muted)" }}>
                {[line.products.length ? line.products.join(", ") : null, line.kwh.length ? `${line.kwh.join(" / ")} kWh` : null].filter(Boolean).join(" · ")}
              </span>
              <span className="font-semibold">× {needText(line)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12.5px]" style={{ color: "var(--bt-muted)" }}>None yet. When the buyer wants several kinds of pack, add each with how many: Matches then shows each supplier with all their stock.</p>
      ))}
      {rows && (
        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {rows.map((row, i) => (
            <fieldset key={i} className="grid grid-cols-1 gap-2 border p-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_70px_70px_auto]" style={{ borderColor: "var(--bt-border)" }}>
              <legend className="sr-only">Pack type {i + 1}</legend>
              <input aria-label={`Pack type ${i + 1}: name`} placeholder="Name, e.g. VW MEB 82 kWh" value={row.label} onChange={(e) => set(i, "label", e.target.value)} className={inputClass} style={inputStyle} />
              <input aria-label={`Pack type ${i + 1}: words a seller writes`} placeholder="Words, e.g. meb, id.4, q4" value={row.products} onChange={(e) => set(i, "products", e.target.value)} className={inputClass} style={inputStyle} />
              <input aria-label={`Pack type ${i + 1}: kWh`} placeholder="kWh, e.g. 82" inputMode="decimal" value={row.kwh} onChange={(e) => set(i, "kwh", e.target.value)} className={inputClass} style={inputStyle} />
              <input aria-label={`Pack type ${i + 1}: fewest`} placeholder="How many" inputMode="numeric" value={row.qty_min} onChange={(e) => set(i, "qty_min", e.target.value)} className={inputClass} style={inputStyle} />
              <input aria-label={`Pack type ${i + 1}: most`} placeholder="Up to" inputMode="numeric" value={row.qty_max} onChange={(e) => set(i, "qty_max", e.target.value)} className={inputClass} style={inputStyle} />
              <button type="button" className={`${rowFocus} ${buttonClass}`} style={buttonStyle} aria-label={`Remove pack type ${i + 1}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>Remove</button>
            </fieldset>
          ))}
          <p className="text-[12px]" style={{ color: "var(--bt-muted)" }}>Words: makes, models or platforms (meb, stla-m, ioniq 5, zoe, stellantis). kWh: one or more, separated by commas; a pack within 5% counts. Leave Up to empty for one number.</p>
          <ErrorText error={error} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${rowFocus} ${buttonClass}`} style={buttonStyle} disabled={busy || rows.length >= 12} onClick={() => setRows([...rows, blank()])}>Add a pack type</button>
            <button type="submit" className={`${rowFocus} ${darkButtonClass}`} style={darkButtonStyle} disabled={busy}>{busy ? "Saving…" : "Save pack types"}</button>
            <button type="button" className={`${rowFocus} ${buttonClass}`} style={buttonStyle} disabled={busy} onClick={() => { setRows(null); setError(null); }}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
