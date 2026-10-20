"use client";

import { useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, Mail } from "lucide-react";
import { mailDraftPath, type ArtifactRef } from "@/lib/mail-artifacts";
import { approvalLabel, useMailDraft } from "./crm/inbox/mail-draft-view";

export type ArtifactOpenHandler = (path: string, options?: { title?: string }) => Promise<boolean | void> | boolean | void;

// A draft opens by itself once per page session, only while its message streams in.
const autoOpened = new Set<string>();

const TONE = { ok: "var(--color-success)", muted: "var(--color-text-muted)", warn: "var(--color-warning)" } as const;

function excerpt(text: string | null): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 320);
}

/**
 * Inline chat card for a mail draft, in the ReBattery Jules card language: 5px radius,
 * solid hairline border, one-pixel shadow, mono label, hairline-separated sections and a
 * single lime action. The full draft opens in the content panel.
 */
export function MailDraftCard({ artifact, autoOpen, onOpen }: { artifact: Extract<ArtifactRef, { kind: "mail_draft" }>; autoOpen: boolean; onOpen?: ArtifactOpenHandler }) {
  const load = useMailDraft(artifact.id);
  const reduceMotion = Boolean(useReducedMotion());
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
  const recipients = draft ? draft.to_emails.join(", ") || "no recipient" : null;
  const divider = { borderColor: "var(--color-border)" };
  return (
    <motion.section
      aria-label={`Email draft: ${title}`}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.2, 0, 0, 1] }}
      className="not-prose my-3 w-full max-w-[560px] overflow-hidden rounded-[5px] border p-3.5 sm:p-4"
      style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)", color: "var(--color-text)", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
    >
      <div className="flex items-center gap-2.5">
        <Mail className="size-4 shrink-0" strokeWidth={1.75} aria-hidden style={{ color: "var(--color-text-muted)" }} />
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]" style={{ color: "var(--color-text-secondary)" }}>Email draft</span>
        {approval && (
          <span className="ml-auto inline-flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px]" style={{ background: "var(--color-main-bg)", color: TONE[approval.tone] }}>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ background: TONE[approval.tone] }} />
            <span className="truncate">{approval.text}</span>
          </span>
        )}
      </div>

      <h3 className="mt-3 text-[15px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{title}</h3>
      {load.status === "error"
        ? <p className="mt-1 text-xs" style={{ color: "var(--color-error)" }}>{load.message}</p>
        : <p className="mt-1 break-words text-xs" style={{ color: "var(--color-text-muted)" }}>
            {recipients === null ? "Loading draft…" : <>To <span className="font-medium" style={{ color: "var(--color-text)" }}>{recipients}</span>{draft?.from_email ? ` · from ${draft.from_email}` : ""}</>}
          </p>}

      {snippet && <p className="mt-3 line-clamp-3 border-t pt-3 text-[13px] leading-relaxed [text-wrap:pretty]" style={{ ...divider, color: "var(--color-text-secondary)" }}>{snippet}</p>}

      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3" style={divider}>
        <span className="font-mono text-[11px] tracking-[0.06em]" style={{ color: "var(--color-text-muted)" }}>Not sent</span>
        <button type="button" onClick={open} disabled={!onOpen || load.status === "error"} aria-label={`Open email draft: ${title}`}
          className="group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors hover:bg-[var(--color-accent-fill-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-40"
          style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>
          Open draft
          <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
        </button>
      </div>
    </motion.section>
  );
}
