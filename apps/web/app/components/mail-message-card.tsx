"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { mailMessagePath, type ArtifactRef } from "@/lib/mail-artifacts";
import type { MailMessageSummary } from "@/lib/mail-types";
import { excerpt, MailDraftCard, type ArtifactOpenHandler } from "./mail-draft-card";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; message: MailMessageSummary };

/** Loads one logged email by id. Stored mail is immutable, so one fetch is enough. */
export function useMailMessage(id: string): Load {
  const [state, setState] = useState<{ id: string; load: Load } | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      let load: Load;
      try {
        const res = await fetch(`/api/mail/messages/${encodeURIComponent(id)}`);
        if (res.status === 404) {load = { status: "error", message: "This email was not found in your mailbox." };}
        else if (!res.ok) {load = { status: "error", message: "Could not load this email." };}
        else {load = { status: "ready", message: (await res.json()) as MailMessageSummary };}
      } catch {
        load = { status: "error", message: "Could not load this email." };
      }
      if (live) {setState({ id, load });}
    })();
    return () => { live = false; };
  }, [id]);
  return state?.id === id ? state.load : { status: "loading" };
}

function when(value: string | null): string {
  if (!value) {return "";}
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Inline chat card for a logged email, in the same card language as the draft card. The thread opens in the content panel. */
export function MailMessageCard({ artifact, onOpen }: { artifact: Extract<ArtifactRef, { kind: "mail_message" }>; onOpen?: ArtifactOpenHandler }) {
  const load = useMailMessage(artifact.id);
  const reduceMotion = Boolean(useReducedMotion());
  const message = load.status === "ready" ? load.message : null;
  const title = message?.subject || artifact.title || "Email";
  const open = () => { void onOpen?.(mailMessagePath(artifact.id), { title }); };
  const snippet = excerpt(message?.body_text ?? message?.body_preview ?? null);
  const divider = { borderColor: "var(--color-border)" };
  const meta = message ? [message.direction === "inbound" ? `From ${message.from_email ?? "unknown"}` : `To ${message.to_emails.join(", ") || "no recipient"}`, when(message.sent_at ?? message.created_at)].filter(Boolean).join(" · ") : null;
  return (
    <motion.section
      aria-label={`Email: ${title}`}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.28, ease: [0.2, 0, 0, 1] }}
      className="not-prose my-3 w-full max-w-[560px] overflow-hidden rounded-[5px] border p-3.5 sm:p-4"
      style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)", color: "var(--color-text)", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}
    >
      <h3 className="text-[15px] font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]">{title}</h3>
      {load.status === "error"
        ? <p className="mt-1 text-xs" style={{ color: "var(--color-error)" }}>{load.message}</p>
        : <p className="mt-1 break-words text-xs" style={{ color: "var(--color-text-muted)" }}>{meta ?? "Loading email…"}</p>}

      {snippet && <p className="mt-3 line-clamp-3 border-t pt-3 text-[13px] leading-relaxed [text-wrap:pretty]" style={{ ...divider, color: "var(--color-text-secondary)" }}>{snippet}</p>}

      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3" style={divider}>
        <span className="truncate font-mono text-[11px] tracking-[0.06em]" style={{ color: "var(--color-text-muted)" }}>
          {message ? `${message.direction === "inbound" ? "Received" : "Sent"}${message.has_attachments ? " · attachments" : ""}` : "Email"}
        </span>
        <button type="button" onClick={open} disabled={!onOpen || load.status === "error"} aria-label={`Open email: ${title}`}
          className="group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors hover:bg-[var(--color-accent-fill-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-40"
          style={{ background: "var(--color-accent-fill)", color: "var(--color-accent-foreground)" }}>
          Open email
          <ArrowUpRight className="size-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" aria-hidden />
        </button>
      </div>
    </motion.section>
  );
}

/** Picks the card for an artifact block by kind. */
export function ArtifactCard({ artifact, autoOpen, onOpen }: { artifact: ArtifactRef; autoOpen: boolean; onOpen?: ArtifactOpenHandler }) {
  return artifact.kind === "mail_message"
    ? <MailMessageCard artifact={artifact} onOpen={onOpen} />
    : <MailDraftCard artifact={artifact} autoOpen={autoOpen} onOpen={onOpen} />;
}
