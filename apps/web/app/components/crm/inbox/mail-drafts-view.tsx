"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import type { MailDraftListRow } from "@/lib/mail-types";
import { formatAbsoluteDate, formatRelativeDate } from "../format-relative-date";
import styles from "./mail.module.css";

/** Prepared drafts waiting for review. Opening one shows it in the content panel. */
export function MailDraftsView({ query, onOpenDraft }: { query: string; onOpenDraft?: (id: string, title: string) => void }) {
  const [rows, setRows] = useState<MailDraftListRow[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void fetch(`/api/mail/drafts?${query}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const page = (await res.json()) as { items: MailDraftListRow[] };
        if (!controller.signal.aborted) {setRows(page.items); setState("ready");}
      })
      .catch(() => { if (!controller.signal.aborted) {setState("error");} });
    return () => controller.abort();
  }, [query]);
  const shown = rows;
  return <div className="text-[13px]">
    {state === "loading" && <p role="status" className="px-8 py-6" style={{ color: "var(--color-text-muted)" }}>Loading drafts…</p>}
    {state === "error" && <p role="alert" className="px-8 py-6" style={{ color: "var(--color-error)" }}>Could not load drafts.</p>}
    {state === "ready" && !shown.length && <p className="px-8 py-8" style={{ color: "var(--color-text-muted)" }}>No drafts waiting. Ask mailvin to prepare one.</p>}
    <ul>{shown.map((row) => {
      const title = row.subject || "(No subject)";
      return <li key={row.id}>
        <button type="button" className={`${styles.logRow} flex w-full items-center gap-3 text-left`} aria-label={`Open draft: ${title}`} onClick={() => onOpenDraft?.(row.id, title)}>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg" style={{ background: "var(--color-surface-hover)", color: "var(--color-text-secondary)" }}><FileText size={14} aria-hidden /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px]">{title}</span>
            <span className="block truncate text-[12px]" style={{ color: "var(--color-text-muted)" }}>To {row.to_emails.join(", ") || "no recipient"}{row.identity_key ? ` · from ${row.identity_key}` : ""}</span>
          </span>
          <span className="shrink-0 text-[11px]" style={{ color: "var(--color-text-muted)" }} title={formatAbsoluteDate(row.created_at)}>{formatRelativeDate(row.created_at)}</span>
        </button>
      </li>;
    })}</ul>
  </div>;
}
