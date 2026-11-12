"use client";

import { useCallback, useEffect, useState } from "react";
import type { BuyerInterestLine } from "@/lib/crm-postgres/buyer-interest";
import { Button } from "../ui/button";
import { formatDayLabel } from "./format-relative-date";

/**
 * The Buyer tab's Wants table: every dated want for this buyer, on one product key.
 *
 * Mastered lines (standing, interest, inferred) are added, edited and expired here. Synced lines (ask, saved
 * search, bought, declined) belong to their source row and are read-only; their link opens that source.
 */

const cardStyle = { borderColor: "var(--color-border)", background: "var(--color-surface)" };
const muted = { color: "var(--color-text-muted)" };
const inputClass = "h-8 w-full rounded-md border px-2 text-[13px]";
const inputStyle = { borderColor: "var(--color-border)", background: "var(--color-background)", color: "var(--color-text)" };

const KINDS = [
  { value: "standing", label: "Standing" },
  { value: "interest", label: "Interest" },
  { value: "inferred", label: "Inferred" },
] as const;
const FORMATS = [
  { value: "", label: "Any format" },
  { value: "pack", label: "Packs" },
  { value: "module", label: "Modules" },
  { value: "cell", label: "Cells" },
  { value: "system", label: "Systems" },
] as const;
const QUANTITY_UNITS = ["packs", "modules", "cells", "systems", "kWh", "MWh", "tonnes"];
const CURRENCIES = ["EUR", "USD", "GBP"];
const PRICE_UNITS = ["kWh", "pack", "cell"];

type Draft = {
  kind: string;
  make: string;
  model: string;
  part_numbers: string;
  chemistry: string;
  format: string;
  kwh_min: string;
  kwh_max: string;
  quantity: string;
  quantity_unit: string;
  price: string;
  price_currency: string;
  price_unit: string;
  expires_on: string;
};

const EMPTY: Draft = {
  kind: "standing", make: "", model: "", part_numbers: "", chemistry: "", format: "", kwh_min: "", kwh_max: "",
  quantity: "", quantity_unit: "", price: "", price_currency: "", price_unit: "", expires_on: "",
};

function toDraft(line: BuyerInterestLine): Draft {
  return {
    kind: line.kind,
    make: line.make ?? "",
    model: line.model ?? "",
    part_numbers: "",
    chemistry: line.chemistry ?? "",
    format: line.format ?? "",
    kwh_min: line.kwh_min === null ? "" : String(line.kwh_min),
    kwh_max: line.kwh_max === null ? "" : String(line.kwh_max),
    quantity: line.quantity === null ? "" : String(line.quantity),
    quantity_unit: line.quantity_unit ?? "",
    price: line.price === null ? "" : String(line.price),
    price_currency: line.price_currency ?? "",
    price_unit: line.price_unit ?? "",
    expires_on: line.expires_on ?? "",
  };
}

/** Only what the draft states; empty strings become null so the API keeps or clears a fact on purpose. */
function toBody(draft: Draft) {
  const number = (value: string) => (value.trim() === "" ? null : Number(value.replace(",", ".")));
  return {
    kind: draft.kind,
    make: draft.make.trim() || null,
    model: draft.model.trim() || null,
    part_numbers: draft.part_numbers.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean),
    chemistry: draft.chemistry.trim() || null,
    format: draft.format || null,
    kwh_min: number(draft.kwh_min),
    kwh_max: number(draft.kwh_max),
    quantity: number(draft.quantity),
    quantity_unit: draft.quantity_unit || null,
    price: number(draft.price),
    price_currency: draft.price ? draft.price_currency || null : null,
    price_unit: draft.price ? draft.price_unit || null : null,
    expires_on: draft.expires_on || null,
  };
}

function priceText(line: BuyerInterestLine): string | null {
  if (line.price === null) {return null;}
  return `${line.price_currency ?? ""} ${line.price.toLocaleString("en-GB", { maximumFractionDigits: 2 })} / ${line.price_unit ?? "unit"}`
    .replace(/^\s+/, "");
}

export function WantsTable({ companyId }: { companyId: string }) {
  const [lines, setLines] = useState<BuyerInterestLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const endpoint = `/api/crm/companies/${encodeURIComponent(companyId)}/interests`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(endpoint, { headers: { Accept: "application/json" } });
      const body = (await res.json().catch(() => ({}))) as { interests?: BuyerInterestLine[]; error?: string };
      if (!res.ok) {throw new Error(body.error ?? `HTTP ${res.status}`);}
      setLines(body.interests ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load wants.");
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => { void load(); }, [load]);

  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft((current) => (current ? { ...current, [key]: event.target.value } : current));

  async function save() {
    if (!draft) {return;}
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { id: editingId, ...toBody(draft) } : toBody(draft)),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {throw new Error(body.error ?? `HTTP ${res.status}`);}
      setDraft(null);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the want.");
    } finally {
      setSaving(false);
    }
  }

  async function expire(line: BuyerInterestLine) {
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: line.id, action: "expire" }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not expire the want.");
    }
  }

  const field = (key: keyof Draft, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-[12px]" style={muted}>
      {label}
      <input aria-label={label} value={draft?.[key] ?? ""} onChange={set(key)} className={inputClass} style={inputStyle} {...props} />
    </label>
  );

  const active = lines.filter((line) => !line.expired);

  return (
    <section aria-label="Wants" className="rounded-2xl border p-4" style={cardStyle}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
          Wants {lines.length > 0 && <span className="font-normal" style={muted}>· {active.length} live</span>}
        </h3>
        {draft ? (
          <>
            <Button size="sm" variant="outline" onClick={() => { setDraft(null); setEditingId(null); }}>Cancel</Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>{editingId ? "Save" : "Add"}</Button>
          </>
        ) : (
          <Button size="sm" variant="outline" onClick={() => { setDraft({ ...EMPTY }); setEditingId(null); }}>Add want</Button>
        )}
      </div>

      {error && <p role="alert" className="mb-2 text-[13px]" style={{ color: "var(--color-error, #b42318)" }}>{error}</p>}

      {draft && (
        <div className="mb-4 grid grid-cols-1 gap-3 rounded-xl border p-3 sm:grid-cols-3" style={{ borderColor: "var(--color-border)" }}>
          <label className="flex flex-col gap-1 text-[12px]" style={muted}>
            Kind
            <select aria-label="Kind" value={draft.kind} onChange={set("kind")} className={inputClass} style={inputStyle}>
              {KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
            </select>
          </label>
          {field("make", "Make")}
          {field("model", "Model")}
          {field("part_numbers", "Part numbers", { placeholder: "SU001B5189" })}
          {field("chemistry", "Chemistry", { placeholder: "LFP, NMC" })}
          <label className="flex flex-col gap-1 text-[12px]" style={muted}>
            Format
            <select aria-label="Format" value={draft.format} onChange={set("format")} className={inputClass} style={inputStyle}>
              {FORMATS.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
            </select>
          </label>
          {field("kwh_min", "Minimum kWh", { type: "number", step: "0.1", min: "0" })}
          {field("kwh_max", "Maximum kWh", { type: "number", step: "0.1", min: "0" })}
          {field("quantity", "Quantity", { type: "number", step: "1", min: "0" })}
          <label className="flex flex-col gap-1 text-[12px]" style={muted}>
            Quantity unit
            <select aria-label="Quantity unit" value={draft.quantity_unit} onChange={set("quantity_unit")} className={inputClass} style={inputStyle}>
              <option value="">Not set</option>
              {QUANTITY_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {field("price", "Price", { type: "number", step: "0.01", min: "0" })}
          <label className="flex flex-col gap-1 text-[12px]" style={muted}>
            Currency
            <select aria-label="Currency" value={draft.price_currency} onChange={set("price_currency")} className={inputClass} style={inputStyle}>
              <option value="">Not set</option>
              {CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px]" style={muted}>
            Price per
            <select aria-label="Price per" value={draft.price_unit} onChange={set("price_unit")} className={inputClass} style={inputStyle}>
              <option value="">Not set</option>
              {PRICE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
            </select>
          </label>
          {field("expires_on", "Expires on", { type: "date" })}
        </div>
      )}

      {loading ? <p className="text-[13px]" style={muted}>Loading wants…</p>
        : !lines.length ? <p className="text-[13px]" style={muted}>No wants yet. Add one here, or let a survey, saved search, ask or offer fill it.</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]" style={{ color: "var(--color-text)" }}>
                <thead>
                  <tr className="text-[12px]" style={muted}>
                    <th scope="col" className="pb-1 pr-3 font-medium">Product</th>
                    <th scope="col" className="pb-1 pr-3 font-medium">Kind</th>
                    <th scope="col" className="pb-1 pr-3 font-medium">Quantity</th>
                    <th scope="col" className="pb-1 pr-3 font-medium">Price</th>
                    <th scope="col" className="pb-1 pr-3 font-medium">Seen</th>
                    <th scope="col" className="pb-1 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="border-t align-top" style={{ borderColor: "var(--color-border)", opacity: line.expired ? 0.55 : 1 }}>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{line.label}</span>
                        {line.expired && <span className="ml-2 text-[12px]" style={muted}>expired</span>}
                      </td>
                      <td className="py-2 pr-3">
                        <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--color-surface-hover)" }}>
                          {line.kind_label}
                        </span>
                        {line.decline_reason && <div className="mt-1 text-[12px]" style={muted}>{line.decline_reason.replace(/_/g, " ")}</div>}
                      </td>
                      <td className="py-2 pr-3" style={line.quantity === null ? muted : undefined}>
                        {line.quantity === null ? "—" : `${line.quantity}${line.quantity_unit ? ` ${line.quantity_unit}` : ""}`}
                      </td>
                      <td className="py-2 pr-3" style={line.price === null ? muted : undefined}>{priceText(line) ?? "—"}</td>
                      <td className="py-2 pr-3 whitespace-nowrap" style={muted}>
                        {formatDayLabel(line.first_seen)}
                        {line.last_seen !== line.first_seen && <> → {formatDayLabel(line.last_seen)}</>}
                      </td>
                      <td className="py-2">
                        {line.ownership === "synced" ? (
                          line.source
                            ? <a href={line.source.href ?? "#"} target={line.source.href?.startsWith("http") ? "_blank" : undefined}
                                rel="noreferrer" className="underline" style={{ color: "var(--color-accent)" }}>
                                {line.source.label}
                              </a>
                            : <span style={muted}>Synced</span>
                        ) : (
                          <span className="flex gap-2">
                            <button type="button" className="underline" style={{ color: "var(--color-accent)" }}
                              onClick={() => { setDraft(toDraft(line)); setEditingId(line.id); }} aria-label={`Edit ${line.label}`}>
                              Edit
                            </button>
                            {!line.expired && (
                              <button type="button" className="underline" style={muted}
                                onClick={() => void expire(line)} aria-label={`Expire ${line.label}`}>
                                Expire
                              </button>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </section>
  );
}
