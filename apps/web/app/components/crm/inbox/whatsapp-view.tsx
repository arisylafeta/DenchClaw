"use client";

import { useEffect, useState } from "react";
import type { WhatsappInboxRow } from "@/lib/crm-postgres/whatsapp";
import { whatsappChatLabel } from "@/lib/whatsapp-display";
import { WhatsappConversation } from "../whatsapp-chat";
import { Loading } from "../../ui/shimmer";
import { InboxLayout, PANEL_LAYOUT } from "./inbox-layout";
import { MailLine } from "./mail-line";
import styles from "./mail.module.css";

const pageSize = 50;
/** Captured WhatsApp chats as a panel: single-line chat rows on the left, the open chat on the right. */
export function WhatsappView({ query, selectedId, onSelect }: { query?: string; selectedId?: string; onSelect?: (id: string) => void }) {
  const [rows, setRows] = useState<WhatsappInboxRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [local, setLocal] = useState<string | null>(null);
  const selected = selectedId ?? local ?? null;
  const select = (id: string | null) => { setLocal(id); onSelect?.(id ?? ""); };
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
  const shown = needle ? rows.filter((row) => `${whatsappChatLabel(row).text} ${row.last_body ?? ""}`.toLowerCase().includes(needle)) : rows;
  const list = <div className="h-full min-h-0 overflow-y-auto text-[13px]" style={{ background: "var(--color-bg)" }}>
    {state === "loading" && !rows.length && <Loading label="Loading WhatsApp chats…" />}
    {state === "error" && <p role="alert" className="px-6 py-6" style={{ color: "var(--color-error)" }}>Could not load WhatsApp chats.</p>}
    {state === "ready" && !shown.length && <p className="px-6 py-8" style={{ color: "var(--color-text-muted)" }}>No captured WhatsApp chats{needle ? " match your search" : ""}.</p>}
    <ul aria-label="WhatsApp chats">{shown.map((row) => {
      const label = whatsappChatLabel(row);
      return <li key={row.id}>
        <MailLine id={row.id} prefix={row.last_direction === "outbound" ? "You:" : undefined} name={label.inferred ? `${label.text} ~` : label.text} nameTitle={label.hint} email={null}
          subject={row.last_body?.trim().split("\n")[0] || "(no text)"} snippet={null} at={row.last_at ?? row.last_captured_at} selected={selected === row.id}
          label={`Open chat: ${label.text}`} onOpen={() => select(row.id)}
          tag={<span className={styles.chip} title={row.kind === "group" ? "Group chat: shared context, not proof every message concerns one contact" : "One-to-one chat"}>{row.kind === "group" ? "Group" : "1:1"} · {row.message_count}</span>} />
      </li>;
    })}</ul>
    {hasMore && <button type="button" className={`${styles.control} m-4`} disabled={state === "loading"} onClick={() => setOffset((current) => current + pageSize)}>Load more</button>}
  </div>;
  return <InboxLayout {...PANEL_LAYOUT} hasSelection={Boolean(selected)} list={list}
    conversation={selected ? <WhatsappConversation key={selected} id={selected} embedded onClose={() => select(null)} /> : <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center" style={{ background: "var(--color-main-bg)" }}><span className="text-lg font-medium">Pick a chat</span><span className="max-w-xs text-[13px]" style={{ color: "var(--color-text-muted)" }}>Open a chat to read its captured history here. Read only.</span></div>} />;
}
