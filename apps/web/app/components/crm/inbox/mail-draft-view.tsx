"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, FileText } from "lucide-react";
import type { MailDraft } from "@/lib/mail-types";
import { MessageBody } from "./message-body";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; draft: MailDraft };

export function useMailDraft(id: string): Load {
  const [state, setState] = useState<{ id: string; load: Load } | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(`/api/mail/drafts/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (res.status === 404) {return { status: "error", message: "This draft was not found." } as Load;}
        if (!res.ok) {return { status: "error", message: "Could not load this draft." } as Load;}
        return { status: "ready", draft: (await res.json()) as MailDraft } as Load;
      })
      .catch((): Load => ({ status: "error", message: "Could not load this draft." }))
      .then((load) => { if (live) {setState({ id, load });} });
    return () => { live = false; };
  }, [id]);
  return state?.id === id ? state.load : { status: "loading" };
}

/** Approval wording follows the CLI: DenchClaw reports it, only the CLI grants it. */
export function approvalLabel(draft: Pick<MailDraft, "approval" | "state">, now = Date.now()): { tone: "ok" | "muted" | "warn"; text: string } {
  const a = draft.approval;
  if (!a) {return { tone: "muted", text: "Awaiting approval" };}
  if (a.revoked_at) {return { tone: "warn", text: "Approval revoked" };}
  if (a.expires_at && Date.parse(a.expires_at) < now) {return { tone: "warn", text: "Approval expired" };}
  return { tone: "ok", text: `Approved by ${a.approved_by}${a.scope === "pilot" ? " (pilot)" : ""}` };
}

const TONE: Record<"ok" | "muted" | "warn", string> = { ok: "var(--color-success)", muted: "var(--color-text-muted)", warn: "var(--color-warning)" };

function plainCopy(draft: MailDraft): string {
  const lines = [`To: ${draft.to_emails.join(", ")}`];
  if (draft.cc_emails.length) {lines.push(`Cc: ${draft.cc_emails.join(", ")}`);}
  if (draft.bcc_emails.length) {lines.push(`Bcc: ${draft.bcc_emails.join(", ")}`);}
  lines.push(`Subject: ${draft.subject ?? ""}`, "", draft.body_text ?? "");
  return lines.join("\n");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 border-b py-2 text-[13px] last:border-b-0" style={{ borderColor: "var(--color-border)" }}>
      <dt className="w-14 shrink-0 pt-px text-[12px]" style={{ color: "var(--color-text-muted)" }}>{label}</dt>
      <dd className="min-w-0 flex-1 break-words" style={{ color: "var(--color-text)" }}>{children}</dd>
    </div>
  );
}

/** Content-tab view of one prepared mail draft. Read-only: approval and send stay in the CLI. */
export function MailDraftView({ draftId }: { draftId: string }) {
  const load = useMailDraft(draftId);
  const [copied, setCopied] = useState(false);
  const draft = load.status === "ready" ? load.draft : null;
  const copy = useCallback(async () => {
    if (!draft) {return;}
    try { await navigator.clipboard.writeText(plainCopy(draft)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard unavailable */ }
  }, [draft]);

  if (load.status === "loading") {
    return <div role="status" className="p-6 text-[13px]" style={{ color: "var(--color-text-muted)" }}>Loading draft…</div>;
  }
  if (load.status === "error") {
    return <div role="alert" className="p-6 text-[13px]" style={{ color: "var(--color-error)" }}>{load.message}</div>;
  }
  const d = load.draft;
  const approval = approvalLabel(d);
  const sent = d.state !== "draft" && d.state !== "frozen";
  return (
    <section aria-label="Email draft" className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-surface)", color: "var(--color-text)" }}>
      <header className="flex min-h-14 shrink-0 items-center gap-2.5 border-b px-4 py-3 sm:px-6" style={{ borderColor: "var(--color-border)" }}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}>
          <FileText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold sm:text-base">{d.subject || "(no subject)"}</h2>
          <p className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
            {sent ? `Already ${d.state}` : "Draft"}{d.identity_key ? ` from ${d.identity_key}` : ""}
          </p>
        </div>
        <button type="button" onClick={() => void copy()} aria-label="Copy draft as text" title="Copy draft as text"
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
          style={{ borderColor: "var(--color-border)" }}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        <dl className="mb-5 rounded-lg border px-3.5" style={{ borderColor: "var(--color-border)", background: "var(--color-main-bg)" }}>
          <Field label="From">{d.from_email ?? d.identity_key ?? "Unknown sender"}</Field>
          <Field label="To">{d.to_emails.length ? d.to_emails.join(", ") : <span style={{ color: "var(--color-warning)" }}>No recipient</span>}</Field>
          {d.cc_emails.length > 0 && <Field label="Cc">{d.cc_emails.join(", ")}</Field>}
          {d.bcc_emails.length > 0 && <Field label="Bcc">{d.bcc_emails.join(", ")}</Field>}
          <Field label="Subject">{d.subject ?? ""}</Field>
        </dl>

        <article aria-label="Message body" className="rounded-lg border px-5 py-4" style={{ borderColor: "var(--color-border)", background: "#fff", color: "#1c1c1a" }}>
          <MessageBody body={d.body_text} html={d.body_html} preview={null} />
        </article>

        {d.links.length > 0 && (
          <div className="mt-4 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
            <p className="mb-1 font-medium">Links frozen into this draft</p>
            <ul className="space-y-0.5">{d.links.map((link) => <li key={`${link.cta_key}:${link.destination_url}`} className="break-all">{link.cta_key}: {link.destination_url}</li>)}</ul>
          </div>
        )}
        {d.warnings.length > 0 && (
          <ul role="status" className="mt-4 space-y-0.5 text-[12px]" style={{ color: "var(--color-warning)" }}>{d.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-3 text-[12px] sm:px-6" style={{ borderColor: "var(--color-border)" }}>
        <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: TONE[approval.tone] }}>
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: TONE[approval.tone] }} />
          {approval.text}
        </span>
        <span style={{ color: "var(--color-text-muted)" }}>Approve and send with rebattery-mail. Nothing is sent from here.</span>
      </footer>
    </section>
  );
}
