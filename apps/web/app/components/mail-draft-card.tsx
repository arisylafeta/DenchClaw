"use client";

import { useEffect } from "react";
import { ChevronRight, FileText } from "lucide-react";
import { mailDraftPath, type ArtifactRef } from "@/lib/mail-artifacts";
import { approvalLabel, useMailDraft } from "./crm/inbox/mail-draft-view";

export type ArtifactOpenHandler = (path: string, options?: { title?: string }) => Promise<boolean | void> | boolean | void;

// A draft opens by itself once per page session, only while its message streams in.
const autoOpened = new Set<string>();

/** Compact chat card for a mail draft artifact. The full draft opens in the content panel. */
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
  return (
    <button type="button" onClick={open} disabled={!onOpen || load.status === "error"}
      aria-label={`Open email draft: ${title}`}
      className="group my-2 flex w-full max-w-md items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-default"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}>
        <FileText className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium" style={{ color: "var(--color-text)" }}>{title}</span>
        <span className="block truncate text-xs" style={{ color: load.status === "error" ? "var(--color-error)" : "var(--color-text-muted)" }}>
          {load.status === "loading" ? "Loading draft…" : load.status === "error" ? load.message : `To ${draft?.to_emails.join(", ") || "no recipient"} · ${approval?.text}`}
        </span>
      </span>
      {load.status !== "error" && <ChevronRight className="size-4 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5" aria-hidden />}
    </button>
  );
}
