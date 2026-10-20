"use client";

import { useEffect } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { mailDraftPath, type ArtifactRef } from "@/lib/mail-artifacts";
import { approvalLabel, useMailDraft } from "./crm/inbox/mail-draft-view";

export type ArtifactOpenHandler = (path: string, options?: { title?: string }) => Promise<boolean | void> | boolean | void;

// A draft opens by itself once per page session, only while its message streams in.
const autoOpened = new Set<string>();

const TONE = { ok: "var(--color-success)", muted: "var(--color-text-muted)", warn: "var(--color-warning)" } as const;

function excerpt(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
}

/** Inline chat component for a mail draft: the recipient, a short excerpt and one action. The full draft opens in the content panel. */
export function MailDraftCard({ artifact, autoOpen, onOpen }: { artifact: Extract<ArtifactRef, { kind: "mail_draft" }>; autoOpen: boolean; onOpen?: ArtifactOpenHandler }) {
  const load = useMailDraft(artifact.id);
  const draft = load.status === "ready" ? load.draft : null;
  const title = draft?.subject || artifact.title || "Email draft";
  const open = () => { void onOpen?.(mailDraftPath(artifact.id), { title }); };

  useEffect(() => {
    if (!autoOpen || !draft || !onOpen || autoOpened.has(artifact.id)) {return;}
    autoOpened.add(artifact.id);
    void onOpen(mailDraftPath(artifact.id), { title });
  }, [autoOpen, draft, onOpen, artifact.id, title]);

  const approval = draft ? approvalLabel(draft) : null;
  const snippet = excerpt(draft?.body_text ?? null);
  return (
    <section aria-label={`Email draft: ${title}`} className="not-prose my-3 w-full max-w-lg overflow-hidden rounded-xl border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", color: "var(--color-text)" }}>
      <div className="flex items-start gap-3 px-4 pt-3.5">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}>
          <FileText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[14px] font-semibold leading-snug">{title}</h3>
          {load.status === "error"
            ? <p className="text-xs" style={{ color: "var(--color-error)" }}>{load.message}</p>
            : <p className="truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
                {draft ? <>To {draft.to_emails.join(", ") || "no recipient"}{draft.from_email ? ` · from ${draft.from_email}` : ""}</> : "Loading draft…"}
              </p>}
        </div>
        {approval && (
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium" style={{ color: TONE[approval.tone] }}>
            <span aria-hidden className="size-1.5 rounded-full" style={{ background: TONE[approval.tone] }} />
            {approval.text}
          </span>
        )}
      </div>
      {snippet && <p className="mx-4 mt-2.5 line-clamp-3 border-l-2 pl-3 text-[13px] leading-relaxed" style={{ borderColor: "var(--color-border-strong)", color: "var(--color-text-secondary)" }}>{snippet}</p>}
      <div className="flex items-center justify-between gap-3 px-4 pb-3.5 pt-3">
        <span className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>Not sent</span>
        <button type="button" onClick={open} disabled={!onOpen || load.status === "error"} aria-label={`Open email draft: ${title}`}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-40"
          style={{ background: "var(--color-text)", color: "var(--color-surface)" }}>
          Open draft <ArrowUpRight className="size-3.5" aria-hidden />
        </button>
      </div>
    </section>
  );
}
