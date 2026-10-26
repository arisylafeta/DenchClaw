"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, FileText, Pencil, Send } from "lucide-react";
import type { MailDraft } from "@/lib/mail-types";
import { Loading } from "../../ui/shimmer";
import { MessageBody } from "./message-body";
import { DraftAttachments, attachmentIssues } from "./draft-attachments";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; draft: MailDraft };

const POLL_MS = 10_000;

/** Loads a draft and keeps it fresh: agents edit saved drafts in place, so refetch on focus and every 10s while visible. */
export function useMailDraft(id: string): Load {
  const [state, setState] = useState<{ id: string; load: Load } | null>(null);
  useEffect(() => {
    let live = true;
    const fetchDraft = async () => {
      let load: Load;
      try {
        const res = await fetch(`/api/mail/drafts/${encodeURIComponent(id)}`);
        if (res.status === 404) {load = { status: "error", message: "This draft was not found." };}
        else if (!res.ok) {load = { status: "error", message: "Could not load this draft." };}
        else {load = { status: "ready", draft: (await res.json()) as MailDraft };}
      } catch {
        load = { status: "error", message: "Could not load this draft." };
      }
      if (!live) {return;}
      setState((prev) => {
        // Keep the last good draft on a transient failure, and skip no-op updates.
        if (load.status === "error" && prev?.id === id && prev.load.status === "ready") {return prev;}
        if (load.status === "ready" && prev?.id === id && prev.load.status === "ready" && prev.load.draft.updated_at === load.draft.updated_at && prev.load.draft.state === load.draft.state) {return prev;}
        return { id, load };
      });
    };
    void fetchDraft();
    const tick = () => { if (document.visibilityState === "visible") {void fetchDraft();} };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", tick); window.removeEventListener("focus", tick); };
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
const SENT_STATES = new Set(["sent", "accepted", "delivered", "opened", "clicked", "replied"]);
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;

/** "23rd Sept 2026 at 21:00", in the viewer's own time zone. */
export function sentWhen(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) { return null; }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${ordinal(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} at ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The line under the title: who it is from while a draft, who sent it and when once it has gone. */
export function draftSubtitle(d: Pick<MailDraft, "state" | "identity_key" | "sent_at" | "accepted_at">): string {
  const who = d.identity_key ? d.identity_key[0].toUpperCase() + d.identity_key.slice(1) : null;
  if (d.state === "draft" || d.state === "frozen") { return `Draft${who ? ` from ${who}` : ""}`; }
  if (d.state === "sending") { return `Sending${who ? ` from ${who}` : ""}…`; }
  if (SENT_STATES.has(d.state)) {
    const when = d.sent_at || d.accepted_at ? sentWhen(String(d.sent_at ?? d.accepted_at)) : null;
    return `Sent${who ? ` by ${who}` : ""}${when ? ` on ${when}` : ""}`;
  }
  return `Already ${d.state}${who ? ` from ${who}` : ""}`;
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

const BUTTON = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50";
const INPUT = "w-full rounded-md border bg-transparent px-2 py-1 text-[13px] outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]";

async function call(url: string, method: string, body: unknown): Promise<MailDraft> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) { throw new Error(data?.error ?? "Something went wrong."); }
  return data as MailDraft;
}

/** Content-tab view of one prepared mail draft. Unsent drafts can be edited here and sent after a confirmation. */
export function MailDraftView({ draftId }: { draftId: string }) {
  const load = useMailDraft(draftId);
  const [copied, setCopied] = useState(false);
  // The latest version this tab saved; wins over the poll until the poll catches up.
  const [saved, setSaved] = useState<MailDraft | null>(null);
  const [edit, setEdit] = useState<{ subject: string; body: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "send" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const polled = load.status === "ready" ? load.draft : null;
  const draft = saved && saved.id === draftId && (!polled || Date.parse(saved.updated_at) >= Date.parse(polled.updated_at)) ? saved : polled;
  const copy = useCallback(async () => {
    if (!draft) {return;}
    try { await navigator.clipboard.writeText(plainCopy(draft)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* clipboard unavailable */ }
  }, [draft]);

  if (!draft && load.status === "loading") {
    return <Loading label="Loading draft…" variant="detail" />;
  }
  if (!draft) {
    return <div role="alert" className="p-6 text-[13px]" style={{ color: "var(--color-error)" }}>{load.status === "error" ? load.message : "Could not load this draft."}</div>;
  }
  const d = draft;
  const approval = approvalLabel(d);
  const sent = d.state !== "draft" && d.state !== "frozen";
  const editable = d.state === "draft" && !d.campaign_id;
  const signature = d.editable?.signature ?? null;
  const startEdit = () => { setNotice(null); setConfirming(false); setEdit({ subject: d.subject ?? "", body: d.editable?.main ?? d.body_text ?? "" }); };
  const dirty = !!edit && (edit.subject !== (d.subject ?? "") || edit.body !== (d.editable?.main ?? d.body_text ?? ""));
  async function save() {
    if (!edit) {return;}
    setBusy("save"); setNotice(null);
    try {
      const updated = await call(`/api/mail/drafts/${encodeURIComponent(d.id)}`, "PATCH", { subject: edit.subject, body: edit.body, updated_at: d.updated_at });
      setSaved(updated); setEdit(null); setNotice({ tone: "ok", text: "Saved." });
    } catch (error) { setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not save." }); }
    finally { setBusy(null); }
  }
  async function send() {
    setBusy("send"); setNotice(null);
    try {
      await call(`/api/mail/drafts/${encodeURIComponent(d.id)}/send`, "POST", { confirm: true, updated_at: d.updated_at });
      setConfirming(false); setNotice({ tone: "ok", text: "Sent." });
      setSaved({ ...d, state: "sent", sent_at: new Date().toISOString() });
    } catch (error) { setConfirming(false); setNotice({ tone: "error", text: error instanceof Error ? error.message : "Could not send." }); }
    finally { setBusy(null); }
  }
  return (
    <section aria-label="Email draft" className="flex h-full min-h-0 flex-col" style={{ background: "var(--color-surface)", color: "var(--color-text)" }}>
      <header className="relative flex min-h-14 shrink-0 items-center gap-2.5 border-b px-4 py-3 sm:px-6" style={{ borderColor: "var(--color-border)" }}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}>
          <FileText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold sm:text-base">{(edit ? edit.subject : d.subject) || "(no subject)"}</h2>
          <p className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
            {edit ? `Editing${d.identity_key ? ` draft from ${d.identity_key[0].toUpperCase()}${d.identity_key.slice(1)}` : ""}` : draftSubtitle(d)}
          </p>
        </div>
        {editable && !edit && (
          <button type="button" onClick={startEdit} aria-label="Edit draft" title="Edit subject and message" className={BUTTON} style={{ borderColor: "var(--color-border)" }}>
            <Pencil className="size-3.5" aria-hidden />Edit
          </button>
        )}
        <button type="button" onClick={() => void copy()} aria-label="Copy draft as text" title="Copy draft as text" className={BUTTON} style={{ borderColor: "var(--color-border)" }}>
          {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        {editable && (
          <button type="button" onClick={() => setConfirming(true)} disabled={!!edit || busy !== null || !d.to_emails.length} aria-haspopup="dialog"
            title={edit ? "Save or cancel your edit first" : !d.to_emails.length ? "Add a recipient first" : "Send this email"}
            className={`${BUTTON} !border-transparent`} style={{ background: "var(--color-accent-fill, var(--color-accent))", color: "var(--color-accent-fill-text, #0a0a0a)" }}>
            <Send className="size-3.5" aria-hidden />Send
          </button>
        )}
        {confirming && (
          <div role="alertdialog" aria-label="Confirm send" className="absolute right-4 top-full z-20 mt-1 w-[min(22rem,calc(100%-2rem))] rounded-lg border p-3 text-[13px] shadow-lg sm:right-6"
            style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
            <p className="font-medium">Send this email now?</p>
            <p className="mt-1 break-words text-[12px]" style={{ color: "var(--color-text-muted)" }}>
              To {d.to_emails.join(", ")}{d.cc_emails.length ? `, Cc ${d.cc_emails.join(", ")}` : ""}<br />
              Subject: {d.subject || "(no subject)"}<br />From: {d.from_email ?? d.identity_key}
            </p>
            {(d.attachments ?? []).length > 0 && <p className="mt-1 break-words text-[12px]" style={{ color: "var(--color-text-muted)" }}>
              With {d.attachments.length} {d.attachments.length === 1 ? "attachment" : "attachments"}: {d.attachments.map((file) => file.filename).join(", ")}
            </p>}
            {attachmentIssues(d.attachments ?? [], d.transport).map((issue) => <p key={issue} role="alert" className="mt-1 text-[12px]" style={{ color: "var(--color-warning)" }}>{issue}</p>)}
            <p className="mt-1 text-[12px]" style={{ color: "var(--color-text-muted)" }}>It goes out straight away and cannot be undone.</p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" autoFocus onClick={() => setConfirming(false)} disabled={busy === "send"} className={BUTTON} style={{ borderColor: "var(--color-border)" }}>Cancel</button>
              <button type="button" onClick={() => void send()} disabled={busy === "send"} className={`${BUTTON} !border-transparent`} style={{ background: "var(--color-accent-fill, var(--color-accent))", color: "var(--color-accent-fill-text, #0a0a0a)" }}>
                {busy === "send" ? "Sending…" : "Yes, send"}
              </button>
            </div>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
        {notice && <p role={notice.tone === "error" ? "alert" : "status"} className="mb-3 text-[12px]" style={{ color: notice.tone === "error" ? "var(--color-error)" : "var(--color-success)" }}>{notice.text}</p>}
        <dl className="mb-5 rounded-lg border px-3.5" style={{ borderColor: "var(--color-border)", background: "var(--color-main-bg)" }}>
          <Field label="From">{d.from_email ?? d.identity_key ?? "Unknown sender"}</Field>
          <Field label="To">{d.to_emails.length ? d.to_emails.join(", ") : <span style={{ color: "var(--color-warning)" }}>No recipient</span>}</Field>
          <Field label="Cc">{d.cc_emails.length ? d.cc_emails.join(", ") : <span style={{ color: "var(--color-text-muted)" }}>None</span>}</Field>
          <Field label="Bcc">{d.bcc_emails.length ? d.bcc_emails.join(", ") : <span style={{ color: "var(--color-text-muted)" }}>None</span>}</Field>
          <Field label="Subject">
            {edit
              ? <input aria-label="Subject" value={edit.subject} maxLength={300} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} className={INPUT} style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }} />
              : d.subject ?? ""}
          </Field>
        </dl>

        <DraftAttachments draftId={d.id} files={d.attachments ?? []} transport={d.transport} />

        {edit ? (
          <div>
            <textarea aria-label="Message" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={Math.min(24, Math.max(10, edit.body.split("\n").length + 2))}
              className={`${INPUT} resize-y rounded-lg px-4 py-3 leading-relaxed`} style={{ borderColor: "var(--color-border)", background: "#fff", color: "#1c1c1a" }} />
            <p className="mt-2 text-[12px]" style={{ color: "var(--color-text-muted)" }}>
              {signature ? "The sender signature is added below your message automatically." : "This draft has no separate signature; everything above is sent as written."} Formatting is plain paragraphs.
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => void save()} disabled={!dirty || busy !== null || !edit.subject.trim() || !edit.body.trim()} className={`${BUTTON} !border-transparent`} style={{ background: "var(--color-accent-fill, var(--color-accent))", color: "var(--color-accent-fill-text, #0a0a0a)" }}>
                {busy === "save" ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setEdit(null)} disabled={busy !== null} className={BUTTON} style={{ borderColor: "var(--color-border)" }}>Cancel</button>
            </div>
          </div>
        ) : (
          <article aria-label="Message body" className="rounded-lg border px-5 py-4" style={{ borderColor: "var(--color-border)", background: "#fff", color: "#1c1c1a" }}>
            <MessageBody body={d.body_text} html={d.body_html} preview={null} ownCopy />
          </article>
        )}

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
        <span style={{ color: "var(--color-text-muted)" }}>{editable ? "Sending here records you as the approver." : "Approve and send with rebattery-mail."}</span>
      </footer>
    </section>
  );
}
