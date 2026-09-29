"use client";

import { useEffect, useId, useState } from "react";
import { TRADE_KINDS, type TradeKind } from "@/lib/bulk-trades";

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body instanceof FormData ? undefined : { "content-type": "application/json" };
  const response = await fetch(url, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export const tradeUrl = (id: string, path = "") => `/api/bulk-trades/${encodeURIComponent(id)}${path}`;

export const inputClass =
  "h-9 w-full rounded-lg border px-2.5 text-sm outline-none focus:border-[var(--bt-text-2)]";
export const inputStyle = { background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" };

/** Secondary button: white with a border. */
export const buttonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-[13px] font-medium hover:bg-[var(--bt-row-hover)] disabled:opacity-50";
export const buttonStyle = { background: "var(--bt-surface)", borderColor: "var(--bt-border)", color: "var(--bt-text)" };

/** Primary button: near-black. */
export const darkButtonClass =
  "inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg px-3 text-[13px] font-medium hover:opacity-90 disabled:opacity-40";
export const darkButtonStyle = { background: "var(--bt-badge)", color: "var(--bt-on-badge)" };

export function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium" style={{ color: "var(--bt-muted)" }}>
      {label}
      {children}
    </label>
  );
}

export function Card({ children, className = "", label }: { children: React.ReactNode; className?: string; label?: string }) {
  return (
    <section
      aria-label={label}
      className={`rounded-[14px] border ${className}`}
      style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}
    >
      {children}
    </section>
  );
}

type ModalProps = {
  title: string;
  onClose: () => void;
  onSubmit?: (event: React.FormEvent) => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  wide?: boolean;
};

/** Centred dialog. Escape and a click outside close it. */
export function Modal({ title, onClose, onSubmit, children, footer, wide }: ModalProps) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const Body = onSubmit ? "form" : "div";
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[10vh]" style={{ background: "rgba(0,0,0,0.3)" }} onClick={onClose}>
      <Body
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={onSubmit}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
        className={`flex w-full flex-col rounded-[14px] border shadow-xl ${wide ? "max-w-[640px]" : "max-w-[440px]"}`}
        style={{ background: "var(--bt-surface)", borderColor: "var(--bt-border)" }}
      >
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--bt-divider)" }}>
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="text-sm" style={{ color: "var(--bt-muted)" }}>Close</button>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">{children}</div>
        <div className="flex items-center justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--bt-divider)" }}>{footer}</div>
      </Body>
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p role="alert" className="text-sm" style={{ color: "var(--bt-red)" }}>{error}</p> : null;
}

/**
 * Form state for the trade dialogs: the draft values, a change handler per key, and a submit that
 * shows the save error in place and re-enables the form on failure.
 */
export function useForm<T extends Record<string, string>>(initial: T, save: (draft: T) => Promise<void>) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof T) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }));

  async function run(action: () => Promise<void>) {
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    }
    setSaving(false);
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void run(() => save(draft));
  };

  const input = (key: keyof T, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input value={draft[key]} onChange={set(key)} className={inputClass} style={inputStyle} {...props} />
  );
  const select = (key: keyof T, options: readonly string[], labels: Record<string, string> = {}) => (
    <select value={draft[key]} onChange={set(key)} className={inputClass} style={inputStyle}>
      {options.map((option) => <option key={option} value={option}>{labels[option] ?? option}</option>)}
    </select>
  );
  const textarea = (key: keyof T, props: React.TextareaHTMLAttributes<HTMLTextAreaElement> = {}) => (
    <textarea value={draft[key]} onChange={set(key)} className="w-full rounded-lg border px-2.5 py-2 text-sm leading-relaxed" style={inputStyle} {...props} />
  );

  return { draft, setDraft, set, saving, error, submit, run, input, select, textarea };
}

/** Shown until a trade has a kind; the kind decides which data fields it needs. */
export function KindPicker({ label, onPick }: { label: string; onPick: (kind: TradeKind) => void }) {
  return (
    <FormField label={label}>
      <select defaultValue="" onChange={(event) => { if (event.target.value) onPick(event.target.value as TradeKind); }}
        className={inputClass} style={inputStyle}>
        <option value="" disabled>Choose…</option>
        {TRADE_KINDS.map((kind) => <option key={kind} value={kind}>{kind[0].toUpperCase() + kind.slice(1)}</option>)}
      </select>
    </FormField>
  );
}
