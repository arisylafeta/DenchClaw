"use client";

import { useEffect, useState } from "react";
import { MailLine } from "./mail-line";
import styles from "./mail.module.css";
import type { WhatsappInboxRow } from "@/lib/crm-postgres/whatsapp";

const pageSize = 50;

/** Captured WhatsApp chats in the same single-line style as mail. Opening one goes to the chat page. */
export function WhatsappView({ query }: { query?: string }) {
  const [rows, setRows] = useState<WhatsappInboxRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const needle = new URLSearchParams(query ?? "").get("q")?.trim().toLowerCase() ?? "";
  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    void fetch(`/api/whatsapp/inbox?limit=${pageSize}&offset=${offset}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
        const page = await res.json() as { threads: WhatsappInboxRow[] };
        if (controller.signal.aborted) {return;}
        setRows((current) => offset === 0 ? page.threads : [...current, ...page.threads]);
        setHasMore(page.threads.length === pageSize);
        setState("ready");
      })
      .catch(() => { if (!controller.signal.aborted) {setState("error");} });
    return () => controller.abort();
  }, [offset]);
  const shown = needle ? rows.filter((row) => `${row.name ?? ""} ${row.last_body ?? ""}`.toLowerCase().includes(needle)) : rows;
  return <div className="text-[13px]">
    {state === "loading" && !rows.length && <p role="status" className="px-8 py-6" style={{ color: "var(--color-text-muted)" }}>Loading WhatsApp chats…</p>}
    {state === "error" && <p role="alert" className="px-8 py-6" style={{ color: "var(--color-error)" }}>Could not load WhatsApp chats.</p>}
    {state === "ready" && !shown.length && <p className="px-8 py-8" style={{ color: "var(--color-text-muted)" }}>No captured WhatsApp chats{needle ? " match your search" : ""}.</p>}
    <ul>{shown.map((row) => {
      const title = row.name || `${row.kind === "group" ? "Unnamed group" : "Direct chat"} ${row.id.slice(0, 6)}`;
      return <li key={row.id}>
        <a href={`/whatsapp/threads/${encodeURIComponent(row.id)}`} className="block">
          <MailLine id={row.id} prefix={row.last_direction === "outbound" ? "You:" : undefined} name={title} email={null}
            subject={row.last_body?.trim().split("\n")[0] || "(no text)"} snippet={null} at={row.last_at ?? row.last_captured_at}
            tag={<span className={styles.chip} title={row.kind === "group" ? "Group chat: shared context, not proof every message concerns one contact" : "One-to-one chat"}>{row.kind === "group" ? "Group" : "1:1"} · {row.message_count}</span>} />
        </a>
      </li>;
    })}</ul>
    {hasMore && <button type="button" className={`${styles.control} m-4`} disabled={state === "loading"} onClick={() => setOffset((current) => current + pageSize)}>Load more</button>}
  </div>;
}
