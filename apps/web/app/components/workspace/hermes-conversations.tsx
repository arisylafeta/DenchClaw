"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { filterConversations, type HermesConversation, type HermesMessage } from "@/lib/hermes-conversations";
import { ProfileAvatar } from "./profile-avatar";

type Listing = { backend: string; sessions: HermesConversation[]; profiles: string[]; warnings: string[]; groupsAvailable: boolean };
type Detail = { conversation: HermesConversation; messages: HermesMessage[]; blocked?: boolean };
async function jsonResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Hermes request failed");
  return data;
}
export function useHermesConversations() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<HermesConversation | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const reload = useCallback(async () => {
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations"));
      if (data.backend === "hermes") setListing(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load chats"); }
  }, []);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 10_000); return () => clearInterval(timer); }, [reload]);
  const read = useCallback(async (row: HermesConversation) => {
    const data: Detail = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}`));
    if (!busyRef.current.has(row.key)) setDetails((prev) => ({ ...prev, [row.key]: data }));
    return data;
  }, []);
  useEffect(() => {
    if (!selected) return;
    let alive = true;
    const load = () => void read(selected).catch((e) => { if (alive) setError(e.message); });
    load();
    const timer = selected.kind === "group" ? setInterval(load, 3000) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [selected, read]);
  const select = (row: HermesConversation) => { setSelected(row); setComposerOpen(false); setError(null); };
  const create = async (profiles: string[]) => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles }) }));
      select(data.conversation); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create chat"); }
    finally { setCreating(false); }
  };
  const send = async (message: string, eventId: string) => {
    const row = selected;
    if (!row || busyRef.current.has(row.key)) return false;
    busyRef.current.add(row.key); setBusy(new Set(busyRef.current)); setError(null);
    try {
      const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, eventId }),
      });
      if (!response.ok) await jsonResponse(response);
      if (row.kind === "group") {
        const data: Detail = await jsonResponse(response);
        setDetails((prev) => ({ ...prev, [row.key]: data }));
      } else {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No Hermes stream");
        const assistantId = `${eventId}-assistant`;
        const updateText = (delta: string, replace = false) => setDetails((prev) => {
          const current = prev[row.key] ?? { conversation: row, messages: [] };
          const messages = [...current.messages];
          const index = messages.findIndex((m) => m.id === assistantId);
          if (index < 0) messages.push({ id: assistantId, role: "assistant", text: delta, profile: row.profile });
          else messages[index] = { ...messages[index], text: replace ? delta : messages[index].text + delta };
          return { ...prev, [row.key]: { ...current, messages } };
        });
        setDetails((prev) => ({ ...prev, [row.key]: { ...(prev[row.key] ?? { conversation: row }), messages: [...(prev[row.key]?.messages ?? []), { id: eventId, role: "user", text: message }] } }));
        let buffer = "", completed = false, textSeen = false;
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let boundary: number;
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
              const name = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
              const raw = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
              if (!raw) continue;
              const event = JSON.parse(raw);
              if (name === "assistant.delta" && event.delta) { updateText(event.delta); textSeen = true; }
              if (name === "assistant.completed" && !textSeen && event.content) updateText(event.content, true);
              if (name === "tool.started") textSeen = false;
              if (name === "run.completed") completed = true;
              if (name === "error") throw new Error(event.message || "Hermes run failed");
            }
            if (done) break;
          }
          if (!completed) throw new Error("Hermes stream disconnected. Refresh before retrying.");
        } finally { await reader.cancel(); reader.releaseLock(); }
      }
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Message failed"); return false; }
    finally {
      busyRef.current.delete(row.key); setBusy(new Set(busyRef.current));
      await read(row).catch(() => {}); void reload();
    }
  };
  const stop = async () => {
    if (!selected || selected.kind !== "group") return;
    try {
      const data = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(selected.key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop", eventId: crypto.randomUUID() }) }));
      setDetails((prev) => ({ ...prev, [selected.key]: data })); void reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not stop group"); }
  };
  return { enabled: listing?.backend === "hermes", listing, filter, setFilter, selected, detail: selected ? details[selected.key] : undefined,
    busy, error, creating, composerOpen, newChat: () => setComposerOpen(true), select, create, send, stop, reload };
}
export type HermesChatsController = ReturnType<typeof useHermesConversations>;
export function ParticipantIcons({ row }: { row: HermesConversation }) {
  return <span className="inline-flex shrink-0 -space-x-2" aria-label={`Participants: ${row.participants.map((p) => p.name).join(", ")}`}>
    {row.participants.map((p, index) => <span key={p.memberId || p.profile} className="rounded-full ring-2 ring-[var(--color-bg)]" style={{ zIndex: row.participants.length - index }} title={p.name}><ProfileAvatar name={p.profile} className="h-7 w-7" /></span>)}
  </span>;
}
export function HermesConversationList({ chats }: { chats: HermesChatsController }) {
  const rows = filterConversations(chats.listing?.sessions ?? [], chats.filter);
  return <div className="flex-1 min-h-0 overflow-y-auto p-2" aria-label="Hermes conversations">
    <div className="text-xs px-2 py-2 text-[var(--color-text-muted)]">{chats.filter ? `${chats.filter} chats` : "All chats"}</div>
    {chats.listing?.warnings.map((warning) => <p key={warning} role="status" className="text-xs p-2 text-amber-700">{warning}</p>)}
    {rows.map((row) => {
      const working = chats.busy.has(row.key) || row.working === true;
      return <button key={row.key} type="button" onClick={() => chats.select(row)} aria-current={chats.selected?.key === row.key ? "true" : undefined} className="flex w-full items-center gap-2 p-2 rounded-lg text-left hover:bg-[var(--color-surface-hover)] aria-[current=true]:bg-[var(--color-surface-hover)]">
        <ParticipantIcons row={row} />
        <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{row.title}</span><span className="block text-[10px] text-[var(--color-text-muted)]">{row.kind === "group" ? "Group" : row.profile} · {working ? "Working" : row.working === false ? "Idle" : "Status unavailable"}</span></span>
        {working && <span aria-label="Working" className="animate-pulse text-green-600">●</span>}
      </button>;
    })}
    {!rows.length && <p className="p-3 text-xs">No conversations in this filter.</p>}
  </div>;
}
export function HermesConversationPanel({ chats }: { chats: HermesChatsController }) {
  const [bots, setBots] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const row = chats.selected;
  const previousKey = useRef(row?.key);
  useEffect(() => { if (previousKey.current !== row?.key) { setMessage(""); setEventId(crypto.randomUUID()); previousKey.current = row?.key; } }, [row?.key]);
  const working = !!row && (chats.busy.has(row.key) || chats.detail?.conversation.working === true);
  return <section className="flex-1 min-h-0 flex flex-col" aria-label="Hermes chat">
    <header className="flex items-center gap-3 p-4 border-b border-[var(--color-border)]">
      {row && <ParticipantIcons row={row} />}<h2 className="flex-1 font-medium truncate">{chats.composerOpen ? "New chat" : row?.title || "Hermes chats"}</h2>
      <button type="button" onClick={chats.newChat} className="text-sm">New chat</button>
      {row?.kind === "group" && working && <button type="button" onClick={() => void chats.stop()} className="text-sm">Stop group</button>}
    </header>
    {chats.error && <p role="alert" className="p-3 text-sm text-red-600">{chats.error} <button type="button" onClick={() => void chats.reload()}>Refresh</button></p>}
    {chats.composerOpen || !row ? <div className="p-6 overflow-auto">
      <h3 className="font-medium mb-3">Choose one bot for a solo chat, or two to six for a group</h3>
      {chats.listing?.profiles.map((profile) => <label key={profile} className="flex items-center gap-3 py-2"><input type="checkbox" checked={bots.includes(profile)} disabled={chats.creating} onChange={(e) => setBots((prev) => e.target.checked ? [...prev, profile] : prev.filter((p) => p !== profile))} /><ProfileAvatar name={profile} />{profile}</label>)}
      <button type="button" disabled={chats.creating || !bots.length || bots.length > 6 || (bots.length > 1 && !chats.listing?.groupsAvailable)} onClick={() => void chats.create(bots)} className="mt-4 px-4 py-2 rounded bg-[var(--color-surface-hover)] disabled:opacity-40">{chats.creating ? "Creating…" : bots.length > 1 ? "Create group chat" : "Create solo chat"}</button>
      {bots.length > 1 && !chats.listing?.groupsAvailable && <p className="mt-3 text-sm">The server’s Hermes dashboard connection is not configured for group chats.</p>}
    </div> : <>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5" aria-live="polite">
        {!chats.detail && <p>Loading conversation…</p>}
        {chats.detail?.messages.map((m) => <article key={m.id} className="max-w-3xl mx-auto"><div className="flex items-center gap-2 text-xs font-medium mb-1">{m.profile && <ProfileAvatar name={m.profile} className="h-5 w-5" />}{m.role === "user" ? "You" : m.name || m.profile || "Hermes"}</div><div className="prose dark:prose-invert max-w-none text-sm break-words"><ReactMarkdown>{m.text}</ReactMarkdown></div></article>)}
        {working && <p role="status" className="text-sm">Bots are working…</p>}
        {chats.detail?.blocked && <p role="status" className="text-sm text-amber-700">This group needs attention in Hermes (approval, retry, or cancellation). No automatic retry was sent.</p>}
      </div>
      <form className="p-4 border-t border-[var(--color-border)] flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!message.trim()) return; const sendingKey = row.key; const sent = await chats.send(message, eventId); if (sent && previousKey.current === sendingKey) { setMessage(""); setEventId(crypto.randomUUID()); } }}>
        <textarea aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} disabled={working || !chats.detail} className="flex-1 min-w-0 rounded border border-[var(--color-border)] p-2 bg-transparent text-sm" rows={3} placeholder={row.kind === "group" ? "Message the group (@bot1, @bot2, or @all)" : "Message this bot"} />
        <button type="submit" disabled={working || !chats.detail || !message.trim()} className="px-3 rounded bg-[var(--color-surface-hover)] disabled:opacity-40">Send</button>
      </form>
    </>}
  </section>;
}
