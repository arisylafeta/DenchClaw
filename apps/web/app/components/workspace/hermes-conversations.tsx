"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyChatView, automation, conversationChannel, DEFAULT_VIEW, filterConversations, type ChatView, type GroupBy, type HermesConversation } from "@/lib/hermes-conversations";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/app/components/ui/dropdown-menu";
import { ProfileAvatar } from "./profile-avatar";

type Listing = { backend: string; transport?: "gateway" | "sse"; sessions: HermesConversation[]; profiles: string[]; warnings: string[]; groupsAvailable: boolean };
export type NewChatMode = "solo" | "group";
export type ChatStatus = "running" | "awaiting" | "done" | "idle";
const SEEN_KEY = "hermes-chats-seen";
const VIEW_KEY = "hermes-chats-view";
const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "None" }, { value: "channel", label: "Channel" }, { value: "agent", label: "Agent" },
  { value: "day", label: "Day" }, { value: "job", label: "Scheduled job" },
];
function loadView(): ChatView {
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    if (value && Array.isArray(value.hidden) && value.hidden.every((id: unknown) => typeof id === "string") &&
        GROUP_OPTIONS.some((option) => option.value === value.groupBy)) return { hidden: value.hidden, groupBy: value.groupBy };
  } catch { /* Unavailable or invalid storage uses the default view. */ }
  return DEFAULT_VIEW;
}
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
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<NewChatMode | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  // False until the first listing request settles; separates "still asking" from "not a Hermes backend".
  const [ready, setReady] = useState(false);
  const newChat = useCallback((mode: NewChatMode = "solo") => setDialog(mode), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const clear = useCallback(() => setSelected(null), []);
  const reload = useCallback(async () => {
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations"));
      if (data.backend === "hermes") setListing(data);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load chats"); }
    finally { setReady(true); }
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
  const select = (row: HermesConversation) => { setSelected(row); setDialog(null); setError(null); };
  /** Opens a conversation that is not in the listing (deep link, old chat). Resolves false when it cannot be loaded. */
  const selectKey = useCallback(async (key: string): Promise<boolean> => {
    try {
      const data = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(key)}`));
      if (!data.conversation) return false;
      setSelected(data.conversation); setDialog(null); setError(null);
      return true;
    } catch { return false; }
  }, []);
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
  return { enabled: listing?.backend === "hermes", ready, listing, filter, setFilter, selected,
    forget: (key: string) => { if (selected?.key === key) setSelected(null); void reload(); },
    seen, error, creating, dialog, newChat, closeDialog, clear, select, selectKey, create, rename, reload };
}
export type HermesChatsController = ReturnType<typeof useHermesConversations>;
/** Awaiting human input outranks running; done means unseen output. */
export function chatStatus(row: HermesConversation, chats: Pick<HermesChatsController, "seen" | "selected">, streaming = false, awaiting = false): ChatStatus {
  if (awaiting || row.blocked) return "awaiting";
  if (streaming || row.working === true) return "running";
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
export function HermesConversationList({ chats, workingKeys, awaitingKeys, onOpen }: { chats: HermesChatsController; workingKeys?: Set<string>; awaitingKeys?: Set<string>; onOpen?: () => void }) {
  const rows = filterConversations(chats.listing?.sessions ?? [], chats.filter);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [view, setView] = useState<ChatView>(DEFAULT_VIEW);
  const [query, setQuery] = useState("");
  useEffect(() => { setView(loadView()); }, []);
  const updateView = (next: ChatView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* Keep filtering usable without storage. */ }
  };
  const result = applyChatView(rows, view, query);
  const hiddenLabels = view.hidden.map((id) => result.channels.find((channel) => channel.id === id)!.label);
  return <div className="flex-1 min-h-0 overflow-y-auto p-2" aria-label="Hermes conversations">
    <div className="flex items-center gap-1 pb-2">
      <input type="search" aria-label="Search chats" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-transparent px-2 py-0.5 text-[11px]" />
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Filter and group chats" title="Filter and group" className="relative rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" /></svg>
          {hiddenLabels.length > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-text)]" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-[11px]">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px]">Channels</DropdownMenuLabel>
            {result.channels.map((channel) => <DropdownMenuCheckboxItem key={channel.id} className="text-[11px]" checked={!view.hidden.includes(channel.id)} onCheckedChange={(checked) => updateView({ ...view, hidden: checked ? view.hidden.filter((id) => id !== channel.id) : [...view.hidden, channel.id] })}>
              {channel.label} {channel.count}
            </DropdownMenuCheckboxItem>)}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px]">Group by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.groupBy} onValueChange={(value) => updateView({ ...view, groupBy: value as GroupBy })}>
              {GROUP_OPTIONS.map((option) => <DropdownMenuRadioItem key={option.value} className="text-[11px]" value={option.value}>{option.label}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {hiddenLabels.length > 0 && <button type="button" onClick={() => updateView({ ...view, hidden: [] })} className="px-2 pb-2 text-left text-[10px] text-[var(--color-text-muted)]">{hiddenLabels.join(" and ")} hidden</button>}
    {chats.listing?.warnings.map((warning) => <p key={warning} role="status" className="text-[11px] p-2 text-amber-700">{warning}</p>)}
    {result.sections.map((section) => <section key={section.key} aria-label={section.label ?? undefined}>
      {section.label && <h3 className="px-2 pt-3 pb-1 text-[10px] font-semibold text-[var(--color-text-muted)]">{section.label}</h3>}
      {section.rows.map((row) => {
      const status = chatStatus(row, chats, workingKeys?.has(row.key), awaitingKeys?.has(row.key));
      return <div key={row.key} className="group relative">
        <button type="button" onClick={() => { chats.select(row); onOpen?.(); }} onDoubleClick={() => setRenaming(row.key)} aria-current={chats.selected?.key === row.key ? "true" : undefined} className="flex w-full items-center gap-2 p-2 rounded-lg text-left hover:bg-[var(--color-surface-hover)] aria-[current=true]:bg-[var(--color-surface-hover)]">
          <ParticipantIcons row={row} />
          <span className="min-w-0 flex-1">
            {renaming === row.key
              ? <RenameInput initial={row.title} onCancel={() => setRenaming(null)} onSubmit={async (title) => { const ok = await chats.rename(row, title); if (ok) setRenaming(null); return ok; }} />
              : <span className="block truncate text-[12px] font-medium">{row.title}</span>}
            <span className="block truncate text-[10px] text-[var(--color-text-muted)]">{[formatChatDate(row.updatedAt), view.groupBy !== "agent" ? row.participants.map((participant) => participant.name).join(", ") : "", view.groupBy !== "channel" ? conversationChannel(row).label : ""].filter(Boolean).join(" · ")}</span>
            {automation(row) && <span className="text-[9px] text-[var(--color-text-muted)]">read-only</span>}
          </span>
          <StatusDot status={status} />
        </button>
        {renaming !== row.key && <button type="button" aria-label={`Rename ${row.title}`} title="Rename" onClick={() => setRenaming(row.key)} className="absolute right-6 top-1/2 -translate-y-1/2 hidden group-hover:block rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
        </button>}
      </div>;
      })}
    </section>)}
    {!result.shown && <p className="p-3 text-xs text-[var(--color-text-muted)]">{rows.length ? "No conversations match this view." : `No conversations${chats.filter ? ` for ${chats.filter}` : ""} yet.`}</p>}
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
/** Shown when nothing is selected. Selected chats, solo or group, render in the existing ChatPanel. */
export function HermesConversationPanel(_props: { chats: HermesChatsController }) {
  return <section className="flex-1 min-h-0 flex items-center justify-center text-sm text-[var(--color-text-muted)]" aria-label="Hermes chat">Select a chat, or use + to start one.</section>;
}
