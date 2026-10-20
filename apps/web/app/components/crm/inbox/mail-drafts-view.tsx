"use client";

import { useEffect, useState } from "react";
import type { MailDraftListRow } from "@/lib/mail-types";
import { Loading } from "../../ui/shimmer";
import { MailLine } from "./mail-line";
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
    {state === "loading" && <Loading label="Loading drafts…" />}
    {state === "error" && <p role="alert" className="px-8 py-6" style={{ color: "var(--color-error)" }}>Could not load drafts.</p>}
    {state === "ready" && !shown.length && <p className="px-8 py-8" style={{ color: "var(--color-text-muted)" }}>No drafts waiting. Ask mailvin to prepare one.</p>}
    <ul>{shown.map((row) => {
      const title = row.subject || "(No subject)";
      const to = row.to_emails.join(", ") || "no recipient";
      return <li key={row.id}>
        <MailLine id={row.id} prefix="To:" name={to} email={row.to_emails[0] ?? null} subject={title} snippet={row.body_preview} at={row.created_at}
          label={`Open draft: ${title}`} onOpen={() => onOpenDraft?.(row.id, title)}
          tag={row.identity_key ? <span className={styles.chip} title={`From ${row.identity_key}`}>{row.identity_key}</span> : null} />
      </li>;
    })}</ul>
  </div>;
}
