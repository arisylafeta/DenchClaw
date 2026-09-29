"use client";

import { useEffect, useState } from "react";
import {
  TFS_NEEDED,
  TRADE_KINDS,
  TRADE_STAGES,
  type BulkTrade,
  type TradeOwner,
  type TradePatch,
} from "@/lib/bulk-trades";

type Draft = Record<keyof TradePatch, string>;

const EMPTY: Draft = {
  title: "", trade_stage: "Needs info", trade_kind: "", fact_line: "", next_step: "", next_step_due: "",
  waiting_on: "us", owner_user_id: "", value: "", last_touched: "", clear_by: "", ship_by: "",
  transport_class: "", tfs_needed: "unknown",
};

function draftFrom(trade: BulkTrade | null): Draft {
  if (!trade) return EMPTY;
  const draft = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof Draft)[]) draft[key] = trade[key] ?? "";
  return draft;
}

type Props = {
  trade: BulkTrade | null;
  owners: TradeOwner[];
  today: string;
  onClose: () => void;
  onSave: (patch: TradePatch) => Promise<void>;
  onOpenEvidence?: () => void;
};

const inputClass = "h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:border-[var(--color-accent)]";
const inputStyle = { background: "var(--color-bg)", borderColor: "var(--color-border)", color: "var(--color-text)" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: "var(--color-text-muted)" }}>
      {label}
      {children}
    </label>
  );
}

export function TradeEditor({ trade, owners, today, onClose, onSave, onOpenEvidence }: Props) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(trade));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initial = draftFrom(trade);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const patch: Record<string, string> = {};
    for (const key of Object.keys(draft) as (keyof Draft)[]) {
      if (!trade || draft[key] !== initial[key]) patch[key] = draft[key];
    }
    if (!Object.keys(patch).length) return onClose();
    setSaving(true);
    setError(null);
    try {
      await onSave(patch as TradePatch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
      setSaving(false);
    }
  }

  const input = (key: keyof Draft, type = "text") => (
    <input type={type} value={draft[key]} onChange={set(key)} className={inputClass} style={inputStyle} />
  );
  const select = (key: keyof Draft, options: readonly string[], labels?: Record<string, string>) => (
    <select value={draft[key]} onChange={set(key)} className={inputClass} style={inputStyle}>
      {options.map((option) => <option key={option} value={option}>{labels?.[option] ?? option}</option>)}
    </select>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: "rgba(0,0,0,0.25)" }} onClick={onClose}>
      <form
        onSubmit={save}
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full max-w-[480px] flex-col overflow-y-auto border-l"
        style={{ background: "var(--color-surface)", borderColor: "var(--color-border)" }}
        aria-label={trade ? `Edit ${trade.title}` : "New trade"}
      >
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>{trade ? trade.title : "New trade"}</h2>
          <button type="button" onClick={onClose} className="text-sm" style={{ color: "var(--color-text-muted)" }}>Close</button>
        </div>

        <div className="flex flex-col gap-5 px-5 py-4">
          <section className="flex flex-col gap-3">
            <Field label="Name">
              <input required value={draft.title} onChange={set("title")} className={inputClass} style={inputStyle} />
            </Field>
            <Field label="Fact line">{input("fact_line")}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Stage">{select("trade_stage", TRADE_STAGES)}</Field>
              <Field label="Kind">{select("trade_kind", ["", ...TRADE_KINDS], { "": "Not set" })}</Field>
              <Field label="Value">{input("value")}</Field>
              <Field label="Owner">
                {select("owner_user_id", ["", ...owners.map((owner) => owner.id)],
                  Object.fromEntries([["", "No owner"], ...owners.map((owner) => [owner.id, owner.name])]))}
              </Field>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>Next step</h3>
            <textarea value={draft.next_step} onChange={set("next_step")} rows={2}
              className="w-full rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-[var(--color-accent)]" style={inputStyle} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Due">{input("next_step_due", "date")}</Field>
              <Field label="Waiting on">{select("waiting_on", ["us", "them"], { us: "Us", them: "Them" })}</Field>
              <Field label="Last touched">
                <div className="flex gap-2">
                  {input("last_touched", "date")}
                  <button type="button" onClick={() => setDraft((current) => ({ ...current, last_touched: today }))}
                    className="shrink-0 rounded-lg border px-2 text-xs" style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}>
                    Today
                  </button>
                </div>
              </Field>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>Shipping</h3>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Clear by">{input("clear_by", "date")}</Field>
              <Field label="Ship by">{input("ship_by", "date")}</Field>
              <Field label="Transport class">{input("transport_class")}</Field>
              <Field label="Waste permit (TFS) needed">{select("tfs_needed", TFS_NEEDED, { yes: "Yes", no: "No", unknown: "Unknown" })}</Field>
            </div>
          </section>

          {error && <p role="alert" className="text-sm" style={{ color: "var(--color-error)" }}>{error}</p>}
        </div>

        <div className="mt-auto flex items-center gap-3 border-t px-5 py-4" style={{ borderColor: "var(--color-border)" }}>
          <button type="submit" disabled={saving}
            className="h-9 rounded-lg px-4 text-sm font-semibold disabled:opacity-60"
            style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>
            {saving ? "Saving" : trade ? "Save" : "Create trade"}
          </button>
          {trade && onOpenEvidence && (
            <button type="button" onClick={onOpenEvidence} className="text-sm underline" style={{ color: "var(--color-text-secondary)" }}>
              Evidence and parties
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
