"use client";

import { useEffect, useState } from "react";
import type { WhatsappArchiveRow, WhatsappInboxRow } from "@/lib/crm-postgres/whatsapp";
import { whatsappChatLabel } from "@/lib/whatsapp-display";
import { WhatsappConversation } from "../whatsapp-chat";
import { Loading } from "../../ui/shimmer";
import { InboxLayout, PANEL_LAYOUT } from "./inbox-layout";
import { MailLine, MailLineSkeleton } from "./mail-line";
import styles from "./mail.module.css";

const pageSize = 50;
/** Captured WhatsApp chats as a panel: single-line chat rows on the left, the open chat on the right. */
export function WhatsappView({ query, selectedId, onSelect, onOpenPerson }: { query?: string; selectedId?: string; onSelect?: (id: string) => void; onOpenPerson?: (id: string) => void }) {
  const [rows, setRows] = useState<WhatsappInboxRow[]>([]);
  const [archive, setArchive] = useState<WhatsappArchiveRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [local, setLocal] = useState<string | null>(null);
  const selected = selectedId ?? local ?? null;
  const select = (id: string | null) => { setLocal(id); onSelect?.(id ?? ""); };
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/whatsapp/archive", { signal: controller.signal })
      .then(async (res) => { if (res.ok) { const body = await res.json() as { chats: WhatsappArchiveRow[] }; if (!controller.signal.aborted && Array.isArray(body.chats)) { setArchive(body.chats); } } })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
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
  type Entry = { id: string; name: string; hint?: string; inferred: boolean; last: string; outbound: boolean; at: string; tag: string | null; tagTitle: string };
  const entries: Entry[] = [
    ...rows.map((row): Entry => { const label = whatsappChatLabel(row); return { id: row.id, name: label.text, hint: label.hint, inferred: label.inferred, last: row.last_body?.trim().split("\n")[0] || "(no text)", outbound: row.last_direction === "outbound", at: row.last_at ?? row.last_captured_at, tag: row.kind === "group" ? "Group" : null, tagTitle: "Group chat: shared context, not proof every message concerns one contact" }; }),
    ...archive.map((chat): Entry => ({ id: chat.id, name: chat.name, hint: "Imported WhatsApp export", inferred: false, last: chat.last_body?.trim().split("\n")[0] || "(no text)", outbound: chat.last_direction === "outbound", at: chat.last_at, tag: chat.linked_trades ? `${chat.linked_trades} linked` : null, tagTitle: `${chat.linked_trades} messages explicitly linked to trades` })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const shown = needle ? entries.filter((entry) => `${entry.name} ${entry.last}`.toLowerCase().includes(needle)) : entries;
  const list = <div className="h-full min-h-0 overflow-y-auto text-[13px]" style={{ background: "var(--color-bg)" }}>
    {state === "loading" && !rows.length && <Loading label="Loading WhatsApp chats…">{Array.from({ length: 9 }, (_, i) => <MailLineSkeleton key={i} index={i} />)}</Loading>}
    {state === "error" && <p role="alert" className="px-6 py-6" style={{ color: "var(--color-error)" }}>Could not load WhatsApp chats.</p>}
    {state === "ready" && !shown.length && <p className="px-6 py-8" style={{ color: "var(--color-text-muted)" }}>No captured WhatsApp chats{needle ? " match your search" : ""}.</p>}
    <ul aria-label="WhatsApp chats">{shown.map((entry) => <li key={entry.id}>
      <MailLine id={entry.id} prefix={entry.outbound ? "You:" : undefined} name={entry.inferred ? `${entry.name} ~` : entry.name} nameTitle={entry.hint} email={null}
        subject={entry.last} snippet={null} at={entry.at} selected={selected === entry.id} label={`Open chat: ${entry.name}`} onOpen={() => select(entry.id)}
        tag={entry.tag ? <span className={styles.chip} title={entry.tagTitle}>{entry.tag}</span> : null} />
    </li>)}</ul>
    {hasMore && <button type="button" className={`${styles.control} m-4`} disabled={state === "loading"} onClick={() => setOffset((current) => current + pageSize)}>Load more</button>}
  </div>;
  return <InboxLayout {...PANEL_LAYOUT} hasSelection={Boolean(selected)} list={list}
    conversation={selected ? <WhatsappConversation key={selected} id={selected} embedded onClose={() => select(null)} onOpenPerson={onOpenPerson} /> : <div className="flex h-full flex-col items-center justify-center gap-1.5 px-8 text-center" style={{ background: "var(--color-main-bg)" }}><span className="text-lg font-medium">Pick a chat</span><span className="max-w-xs text-[13px]" style={{ color: "var(--color-text-muted)" }}>Open a chat to read its captured history here. Read only.</span></div>} />;
}
