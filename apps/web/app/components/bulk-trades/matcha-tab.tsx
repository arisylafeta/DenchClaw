"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { HermesConversation } from "@/lib/hermes-conversations";
import { ErrorText } from "./trade-ui";

const ChatPanel = dynamic(() => import("@/app/components/chat-panel").then((m) => m.ChatPanel), { ssr: false });

type Opened = { conversation: HermesConversation; transport: "gateway" | "sse" };

/**
 * A normal Matcha chat inside the listing. The conversation is remembered per user and listing, and the listing's
 * path is sent as the chat's context like in a workspace chat. Mounted on first visit and kept, so a running reply
 * is not torn down by switching tabs.
 */
export function MatchaTab({ listingId, active }: { listingId: string; active: boolean }) {
  const [started, setStarted] = useState(active);
  const [opened, setOpened] = useState<{ id: string; chat: Opened } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (active && !started) setStarted(true);
  useEffect(() => {
    if (!started) return;
    let live = true;
    setError(null);
    void fetch(`/api/bulk-listings/${encodeURIComponent(listingId)}/matcha-chat`, { method: "POST" })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.conversation) throw new Error(data?.error ?? "Could not open the Matcha chat.");
        if (live) setOpened({ id: listingId, chat: data });
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : "Could not open the Matcha chat."); });
    return () => { live = false; };
  }, [started, listingId]);
  // /new or a branch inside the tab starts another chat: keep the listing pinned to that one.
  const follow = (conversation: HermesConversation) => {
    setOpened((current) => current && { ...current, chat: { ...current.chat, conversation } });
    void fetch(`/api/bulk-listings/${encodeURIComponent(listingId)}/matcha-chat`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: conversation.key }),
    }).catch(() => undefined);
  };
  if (!started) return null;
  const chat = opened?.id === listingId ? opened.chat : null;
  return (
    <div hidden={!active} aria-label="Matcha chat" className="flex h-[calc(100vh-280px)] min-h-[480px] w-full min-w-0 flex-col overflow-hidden rounded-xl border" style={{ borderColor: "var(--bt-border, var(--color-border))", background: "var(--color-bg)" }}>
      {error ? <div className="p-4"><ErrorText error={error} /></div>
        : !chat ? <p role="status" className="p-4 text-[13px]" style={{ color: "var(--bt-muted)" }}>Opening Matcha…</p>
        : <ChatPanel
            key={chat.conversation.key}
            nativeConversationKey={chat.conversation.key}
            nativeTransport={chat.transport}
            nativeAccess={chat.conversation.access}
            sessionTitle={chat.conversation.title}
            fileContext={{ path: `~trades-preview/listing/${listingId}`, filename: listingId, isDirectory: true }}
            visible={active}
            onBranched={follow}
            compact
          />}
    </div>
  );
}
