"use client";

import { useEffect, useState } from "react";
import { User, Users } from "lucide-react";
import type { WhatsappInboxRow } from "@/lib/crm-postgres/whatsapp";
import { whatsappChatLabel } from "@/lib/whatsapp-display";
import { formatRelativeDate } from "../format-relative-date";
import { WhatsappConversation } from "../whatsapp-chat";
import { InboxLayout } from "./inbox-layout";
import styles from "../whatsapp.module.css";
import { Loading } from "../../ui/shimmer";

const pageSize = 50;

/** Captured WhatsApp chats as a panel: WhatsApp-style chat list on the left, the open chat on the right. */
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
  const list = <div className={`${styles.wa} ${styles.list}`}>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {state === "loading" && !rows.length && <Loading label="Loading WhatsApp chats…" />}
      {state === "error" && <p role="alert" className={styles.listSearchEmpty} style={{ color: "#b3261e" }}>Could not load WhatsApp chats.</p>}
      {state === "ready" && !shown.length && <p className={styles.listSearchEmpty}>No captured WhatsApp chats{needle ? " match your search" : ""}.</p>}
      <ul aria-label="WhatsApp chats">{shown.map((row) => {
        const label = whatsappChatLabel(row);
        const preview = row.last_body?.trim().split("\n")[0] || "(no text)";
        return <li key={row.id}>
          <button type="button" className={styles.item} aria-current={selected === row.id ? "true" : undefined} data-chat-id={row.id} onClick={() => select(row.id)}>
            <span aria-hidden className={styles.avatar} style={{ width: 49, height: 49 }}>{row.kind === "group" ? <Users size={26} /> : <User size={26} />}</span>
            <span className={styles.itemBody}>
              <span className={styles.itemName} title={label.hint}>{label.text}{label.inferred && <span className="ml-1 text-[12px]" style={{ color: "var(--wa-muted)" }}>~</span>}</span>
              <span className={styles.itemPreview}>{row.last_direction === "outbound" ? "You: " : ""}{preview}</span>
            </span>
            <span className={`${styles.itemBody} ${styles.itemTime}`}>{formatRelativeDate(row.last_at ?? row.last_captured_at)}</span>
          </button>
        </li>;
      })}</ul>
      {hasMore && <button type="button" className={styles.pager} disabled={state === "loading"} onClick={() => setOffset((current) => current + pageSize)}>Load more chats</button>}
    </div>
  </div>;
  return <InboxLayout hasSelection={Boolean(selected)} list={list}
    conversation={selected ? <WhatsappConversation key={selected} id={selected} embedded onClose={() => select(null)} /> : <div className={`${styles.wa} ${styles.empty}`}><span className="text-[28px] font-light" style={{ color: "var(--wa-text)" }}>WhatsApp history</span><span className="max-w-sm text-[14px]">Pick a chat to read its captured history. Read only, nothing can be sent from here.</span></div>} />;
}
