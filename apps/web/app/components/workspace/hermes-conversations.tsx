"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { filterConversations, type HermesConversation, type HermesMessage } from "@/lib/hermes-conversations";
import { ProfileAvatar } from "./profile-avatar";

type Listing = { backend: string; sessions: HermesConversation[]; profiles: string[]; warnings: string[]; groupsAvailable: boolean };
type Detail = { conversation: HermesConversation; messages: HermesMessage[]; blocked?: boolean; cursor?: number };
export type NewChatMode = "solo" | "group";
export type ChatStatus = "running" | "awaiting" | "done" | "idle";
const SEEN_KEY = "hermes-chats-seen";
async function jsonResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Hermes request failed");
  return data;
}
function loadSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}"); } catch { return {}; }
}
export function formatChatDate(ms: number, now = new Date()) {
  if (!ms) return "";
  const date = new Date(ms);
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
export function useHermesConversations() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<HermesConversation | null>(null);
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const detailsRef = useRef(details);
  useEffect(() => { detailsRef.current = details; }, [details]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<NewChatMode | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const newChat = useCallback((mode: NewChatMode = "solo") => setDialog(mode), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const clear = useCallback(() => setSelected(null), []);
  const reload = useCallback(async () => {
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations"));
      if (data.backend === "hermes") setListing(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load chats"); }
  }, []);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 10_000); return () => clearInterval(timer); }, [reload]);
  useEffect(() => { setSeen(loadSeen()); }, []);
  // Chats first seen are baselined as read; later activity in a chat you are not viewing shows as "done".
  useEffect(() => {
    if (!listing) return;
    setSeen((prev) => {
      const next = { ...prev };
      for (const row of listing.sessions) if (next[row.key] === undefined || selected?.key === row.key) next[row.key] = Math.max(next[row.key] ?? 0, row.updatedAt);
      if (JSON.stringify(next) === JSON.stringify(prev)) return prev;
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)); } catch { /* Storage unavailable: unread dots reset on reload. */ }
      return next;
    });
  }, [listing, selected?.key]);
  const read = useCallback(async (row: HermesConversation) => {
    const cursor = detailsRef.current[row.key]?.cursor;
    const data: Detail = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}${cursor ? `?since_seq=${cursor}` : ""}`));
    if (!busyRef.current.has(row.key)) setDetails((prev) => ({ ...prev, [row.key]: cursor ? { ...data, cursor: Math.max(cursor, data.cursor ?? cursor), messages: [...new Map([...(prev[row.key]?.messages ?? []), ...data.messages].map((message) => [message.id, message])).values()] } : data }));
    return data;
  }, []);
  useEffect(() => {
    if (!selected || selected.kind !== "group") return;
    let alive = true;
    const load = () => void read(selected).catch((e) => { if (alive) setError(e.message); });
    load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [selected, read]);
  const select = (row: HermesConversation) => { setSelected(row); setDialog(null); setError(null); };
  const create = async (profiles: string[]) => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profiles }) }));
      select(data.conversation); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create chat"); }
    finally { setCreating(false); }
  };
  const rename = async (row: HermesConversation, title: string) => {
    const next = title.trim();
    if (!next || next === row.title) return true;
    try {
      const data = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: next }) }));
      setSelected((current) => current?.key === row.key ? data.conversation : current);
      await reload();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not rename chat"); return false; }
  };
  const send = async (message: string, eventId: string) => {
    const row = selected;
    if (!row || row.kind !== "group" || busyRef.current.has(row.key)) return false;
    busyRef.current.add(row.key); setBusy(new Set(busyRef.current)); setError(null);
    try {
      const response = await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, eventId }),
      });
      if (!response.ok) await jsonResponse(response);
      const data: Detail = await jsonResponse(response);
      setDetails((prev) => ({ ...prev, [row.key]: data }));
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
    forget: (key: string) => { if (selected?.key === key) setSelected(null); void reload(); },
    busy, seen, error, creating, dialog, newChat, closeDialog, clear, select, create, rename, send, stop, reload };
}
export type HermesChatsController = ReturnType<typeof useHermesConversations>;
/** running: work in progress; awaiting: group needs a human; done: new output you have not opened; idle: nothing to show. */
export function chatStatus(row: HermesConversation, chats: Pick<HermesChatsController, "busy" | "seen" | "selected">, streaming = false): ChatStatus {
  if (streaming || chats.busy.has(row.key) || row.working === true) return "running";
  if (row.blocked) return "awaiting";
  if (chats.selected?.key !== row.key && row.updatedAt > (chats.seen[row.key] ?? row.updatedAt)) return "done";
  return "idle";
}
const DOT: Record<Exclude<ChatStatus, "idle">, { className: string; label: string }> = {
  running: { className: "bg-green-500 animate-pulse", label: "Running" },
  awaiting: { className: "bg-amber-500", label: "Needs your attention" },
  done: { className: "bg-blue-500", label: "New activity" },
};
export function StatusDot({ status }: { status: ChatStatus }) {
  if (status === "idle") return null;
  return <span role="img" aria-label={DOT[status].label} title={DOT[status].label} className={`h-2 w-2 shrink-0 rounded-full ${DOT[status].className}`} />;
}
export function ParticipantIcons({ row }: { row: HermesConversation }) {
  return <span className="inline-flex shrink-0 -space-x-2" aria-label={`Participants: ${row.participants.map((p) => p.name).join(", ")}`}>
    {row.participants.map((p, index) => <span key={p.memberId || p.profile} className="rounded-full ring-2 ring-[var(--color-bg)]" style={{ zIndex: row.participants.length - index }} title={p.name}><ProfileAvatar name={p.profile} className="h-7 w-7" /></span>)}
  </span>;
}
function RenameInput({ initial, onSubmit, onCancel }: { initial: string; onSubmit: (title: string) => Promise<boolean>; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const submit = async () => { if (done.current) return; done.current = true; if (!(await onSubmit(value))) done.current = false; };
  return <input autoFocus aria-label="Chat title" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()}
    onClick={(e) => e.stopPropagation()} onBlur={() => void submit()}
    onKeyDown={(e) => { if (e.key === "Enter") void submit(); else if (e.key === "Escape") { done.current = true; onCancel(); } }}
    className="w-full rounded border border-[var(--color-border)] bg-transparent px-1 text-xs font-medium" />;
}
export function HermesConversationList({ chats, workingKeys }: { chats: HermesChatsController; workingKeys?: Set<string> }) {
  const rows = filterConversations(chats.listing?.sessions ?? [], chats.filter);
  const [renaming, setRenaming] = useState<string | null>(null);
  return <div className="flex-1 min-h-0 overflow-y-auto p-2" aria-label="Hermes conversations">
    {chats.listing?.warnings.map((warning) => <p key={warning} role="status" className="text-xs p-2 text-amber-700">{warning}</p>)}
    {rows.map((row) => {
      const status = chatStatus(row, chats, workingKeys?.has(row.key));
      return <div key={row.key} className="group relative">
        <button type="button" onClick={() => chats.select(row)} onDoubleClick={() => setRenaming(row.key)} aria-current={chats.selected?.key === row.key ? "true" : undefined} className="flex w-full items-center gap-2 p-2 rounded-lg text-left hover:bg-[var(--color-surface-hover)] aria-[current=true]:bg-[var(--color-surface-hover)]">
          <ParticipantIcons row={row} />
          <span className="min-w-0 flex-1">
            {renaming === row.key
              ? <RenameInput initial={row.title} onCancel={() => setRenaming(null)} onSubmit={async (title) => { const ok = await chats.rename(row, title); if (ok) setRenaming(null); return ok; }} />
              : <span className="block truncate text-xs font-medium">{row.title}</span>}
            <span className="block truncate text-[10px] text-[var(--color-text-muted)]">{formatChatDate(row.updatedAt)}{row.kind === "solo" ? ` · ${row.profile}` : ""}</span>
          </span>
          <StatusDot status={status} />
        </button>
        {renaming !== row.key && <button type="button" aria-label={`Rename ${row.title}`} title="Rename" onClick={() => setRenaming(row.key)} className="absolute right-6 top-1/2 -translate-y-1/2 hidden group-hover:block rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </button>}
      </div>;
    })}
    {!rows.length && <p className="p-3 text-xs text-[var(--color-text-muted)]">No conversations{chats.filter ? ` for ${chats.filter}` : ""} yet.</p>}
  </div>;
}
export function HermesNewChatDialog({ chats }: { chats: HermesChatsController }) {
  const [mode, setMode] = useState<NewChatMode>("solo");
  const [bots, setBots] = useState<string[]>([]);
  const open = chats.dialog !== null;
  useEffect(() => { if (chats.dialog) { setMode(chats.dialog); setBots([]); } }, [chats.dialog]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") chats.closeDialog(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, chats]);
  if (!open) return null;
  const groupsOff = !chats.listing?.groupsAvailable;
  const toggle = (profile: string) => setBots((prev) => mode === "solo" ? [profile] : prev.includes(profile) ? prev.filter((p) => p !== profile) : [...prev, profile]);
  const valid = mode === "solo" ? bots.length === 1 : bots.length >= 2 && bots.length <= 6 && !groupsOff;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) chats.closeDialog(); }}>
    <div role="dialog" aria-modal="true" aria-label="New chat" className="w-[360px] max-w-[92vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-5 shadow-xl">
      <div className="mb-4 flex rounded-lg bg-[var(--color-surface-hover)] p-0.5 text-sm" role="tablist">
        {(["solo", "group"] as const).map((entry) => <button key={entry} type="button" role="tab" aria-selected={mode === entry} onClick={() => { setMode(entry); setBots((prev) => entry === "solo" ? prev.slice(0, 1) : prev); }} className={`flex-1 rounded-md py-1 ${mode === entry ? "bg-[var(--color-bg)] font-medium shadow-sm" : "text-[var(--color-text-muted)]"}`}>{entry === "solo" ? "Solo" : "Group"}</button>)}
      </div>
      <p className="mb-2 text-xs text-[var(--color-text-muted)]">{mode === "solo" ? "Pick one agent." : "Pick two to six agents."}</p>
      <div role="group" aria-label="Agents">
        {chats.listing?.profiles.map((profile) => <label key={profile} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-[var(--color-surface-hover)]">
          <input type={mode === "solo" ? "radio" : "checkbox"} name="hermes-agent" checked={bots.includes(profile)} disabled={chats.creating} onChange={() => toggle(profile)} />
          <ProfileAvatar name={profile} className="h-7 w-7" /><span className="text-sm">{profile}</span>
        </label>)}
      </div>
      {mode === "group" && groupsOff && <p className="mt-2 text-xs text-amber-700">Group chats are not connected on this server.</p>}
      {chats.error && <p role="alert" className="mt-2 text-xs text-red-600">{chats.error}</p>}
      <div className="mt-4 flex justify-end gap-2 text-sm">
        <button type="button" onClick={chats.closeDialog} className="rounded-lg px-3 py-1.5 hover:bg-[var(--color-surface-hover)]">Cancel</button>
        <button type="button" disabled={chats.creating || !valid} onClick={() => void chats.create(bots)} className="rounded-lg bg-[var(--color-text)] px-3 py-1.5 text-[var(--color-bg)] disabled:opacity-40">{chats.creating ? "Creating…" : "Start chat"}</button>
      </div>
    </div>
  </div>;
}
/** Group timeline, or an empty state when nothing is selected. Solo chats use the existing rich ChatPanel. */
export function HermesConversationPanel({ chats }: { chats: HermesChatsController }) {
  const [message, setMessage] = useState("");
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const row = chats.detail?.conversation ?? chats.selected;
  const previousKey = useRef(row?.key);
  useEffect(() => { if (previousKey.current !== row?.key) { setMessage(""); setEventId(crypto.randomUUID()); previousKey.current = row?.key; } }, [row?.key]);
  const working = !!row && (chats.busy.has(row.key) || chats.detail?.conversation.working === true);
  if (row?.kind === "solo") return null;
  if (!row) return <section className="flex-1 min-h-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]" aria-label="Hermes chat">Select a chat, or use + to start one.</section>;
  return <section className="flex-1 min-h-0 flex flex-col" aria-label="Hermes chat">
    <header className="flex items-center gap-3 p-4 border-b border-[var(--color-border)]">
      <ParticipantIcons row={row} /><h2 className="flex-1 font-medium truncate">{row.title}</h2>
      {working && <button type="button" onClick={() => void chats.stop()} className="text-sm">Stop group</button>}
    </header>
    {chats.error && <p role="alert" className="p-3 text-sm text-red-600">{chats.error} <button type="button" onClick={() => void chats.reload()}>Refresh</button></p>}
    <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5" aria-live="polite">
      {!chats.detail && <p>Loading conversation…</p>}
      {chats.detail?.messages.map((m) => <article key={m.id} className="max-w-3xl mx-auto"><div className="flex items-center gap-2 text-xs font-medium mb-1">{m.profile && <ProfileAvatar name={m.profile} className="h-5 w-5" />}{m.role === "user" ? "You" : m.name || m.profile || "Hermes"}</div><div className="prose dark:prose-invert max-w-none text-sm break-words"><ReactMarkdown>{m.text}</ReactMarkdown></div></article>)}
      {working && <p role="status" className="text-sm">Group has active or queued work…</p>}
      {chats.detail?.blocked && <p role="status" className="text-sm text-amber-700">This group needs attention in Hermes (approval, retry, or cancellation). No automatic retry was sent.</p>}
    </div>
    <form className="p-4 border-t border-[var(--color-border)] flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!message.trim()) return; const sendingKey = row.key; const sent = await chats.send(message, eventId); if (sent && previousKey.current === sendingKey) { setMessage(""); setEventId(crypto.randomUUID()); } }}>
      <textarea aria-label="Message" value={message} onChange={(e) => setMessage(e.target.value)} disabled={working || !chats.detail} className="flex-1 min-w-0 rounded border border-[var(--color-border)] p-2 bg-transparent text-sm" rows={3} placeholder={`Message the group (${row.participants.map((p) => p.handle ? `@${p.handle}` : p.name).join(", ")}, or @all)`} />
      <button type="submit" disabled={working || !chats.detail || !message.trim()} className="px-3 rounded bg-[var(--color-surface-hover)] disabled:opacity-40">Send</button>
    </form>
  </section>;
}
