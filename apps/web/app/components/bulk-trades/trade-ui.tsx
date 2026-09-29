"use client";

import { useEffect, useId } from "react";

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
