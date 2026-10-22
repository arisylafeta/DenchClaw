"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyChatView, automation, conversationChannel, DEFAULT_VIEW, filterConversations, messagingConversation, parseChatView, type ChatView, type GroupBy, type HermesConversation } from "@/lib/hermes-conversations";
import { ChevronRight, MessageCircle, Users, Pin, PinOff, Clock3, Hash, Pencil, Copy, MoreVertical } from "lucide-react";
import { FaDiscord, FaWhatsapp } from "react-icons/fa";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/app/components/ui/dropdown-menu";
import { motion } from "framer-motion";
import { ProfileAvatar } from "./profile-avatar";
import { useConversationReorderMotion } from "./use-conversation-reorder-motion";
import styles from "./hermes-conversations.module.css";

type Listing = { backend: string; transport?: "gateway" | "sse"; sessions: HermesConversation[]; profiles: string[]; warnings: string[]; groupsAvailable: boolean };
export type NewChatMode = "solo" | "group";
export type ChatStatus = "running" | "awaiting" | "background" | "done" | "idle";
const SEEN_KEY = "hermes-chats-seen";
const VIEW_KEY = "hermes-chats-view";
const ALIAS_KEY = "hermes-chats-aliases";
const PROFILE_FILTER_KEY = "hermes-chats-profile-filter";
const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "source", label: "Source sections" }, { value: "channel", label: "Channel" }, { value: "agent", label: "Agent" },
  { value: "day", label: "Day" }, { value: "job", label: "Scheduled job" },
];
function loadView(): ChatView {
  try {
    return parseChatView(JSON.parse(localStorage.getItem(VIEW_KEY) || "null"));
  } catch { /* Unavailable or invalid storage uses the default view. */ }
  return DEFAULT_VIEW;
}
async function jsonResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Hermes request failed");
  return data;
}
function loadSeen(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))) : {};
  } catch { return {}; }
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
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PROFILE_FILTER_KEY) || "null");
      if (typeof saved === "string" && saved.length > 0 && saved.length <= 200) setFilter(saved);
    } catch { /* Profile filter starts at All chats. */ }
  }, []);
  const updateFilter = useCallback((profile: string | null) => {
    setFilter(profile);
    try { localStorage.setItem(PROFILE_FILTER_KEY, JSON.stringify(profile)); } catch { /* In-memory filtering still works. */ }
  }, []);
  const [selected, setSelected] = useState<HermesConversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [lastCreatedKey, setLastCreatedKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NewChatMode | null>(null);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ALIAS_KEY) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) setAliases(Object.fromEntries(Object.entries(saved).filter(([, name]) => typeof name === "string" && name.trim().length > 0 && name.length <= 200)) as Record<string, string>);
    } catch { /* Local aliases remain usable without storage. */ }
  }, []);
  // False until the first listing request settles; separates "still asking" from "not a Hermes backend".
  const [ready, setReady] = useState(false);
  const newChat = useCallback((mode: NewChatMode = "solo") => setDialog(mode), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const clear = useCallback(() => setSelected(null), []);
  const [pins, setPins] = useState<string[]>([]);
  const reload = useCallback(async () => {
    try {
      const data = await jsonResponse(await fetch("/api/hermes/conversations"));
      if (data.backend === "hermes") setListing(data);
      setError(null);
      // Pins are per signed-in user on the server; a failed read keeps the last known set.
      try {
        const saved = await (await fetch("/api/hermes/pins")).json();
        if (Array.isArray(saved?.pins)) setPins(saved.pins.filter((id: unknown) => typeof id === "string"));
      } catch { /* Keep the previous pins. */ }
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
      setLastCreatedKey(data.conversation.key);
      select(data.conversation); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create chat"); }
    finally { setCreating(false); }
  };
  const rename = async (row: HermesConversation, title: string) => {
    const next = title.trim();
    if (!next || next === row.title) return true;
    if (messagingConversation(row)) {
      const updated = { ...aliases, [row.key]: next.slice(0, 200) };
      setAliases(updated);
      try { localStorage.setItem(ALIAS_KEY, JSON.stringify(updated)); } catch { /* In-memory rename still works. */ }
      return true;
    }
    try {
      const data = await jsonResponse(await fetch(`/api/hermes/conversations/${encodeURIComponent(row.key)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: next }) }));
      setSelected((current) => current?.key === row.key ? data.conversation : current);
      await reload();
      return true;
    } catch (e) { setError(e instanceof Error ? e.message : "Could not rename chat"); return false; }
  };
  const setPinned = useCallback(async (key: string, pinned: boolean) => {
    const previous = pins;
    setPins(pinned ? [...new Set([...previous, key])] : previous.filter((id) => id !== key));
    try {
      const response = await fetch("/api/hermes/pins", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, pinned }) });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data.pins)) throw new Error(data?.error === "chat_not_found" ? "That chat no longer exists" : "Could not update pin");
      setPins(data.pins);
    } catch (e) { setPins(previous); setError(e instanceof Error ? e.message : "Could not update pin"); }
  }, [pins]);
  // One-time move of browser-local pins (pre-server) into this user's server pins. Stale keys are skipped by the server.
  const migrated = useRef(false);
  useEffect(() => {
    if (!ready || !listing || migrated.current) return;
    migrated.current = true;
    let local: string[] = [];
    try { local = loadView().pins ?? []; } catch { /* Nothing to migrate. */ }
    if (!local.length) return;
    void (async () => {
      for (const key of local) {
        try { await fetch("/api/hermes/pins", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, pinned: true }) }); } catch { /* Skip; the next load retries. */ }
      }
      try {
        const saved = await (await fetch("/api/hermes/pins")).json();
        if (Array.isArray(saved?.pins)) setPins(saved.pins);
        const view = loadView();
        localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, pins: [] }));
      } catch { /* Local pins stay until a later load succeeds. */ }
    })();
  }, [ready, listing]);
  const display = useCallback((row: HermesConversation) => messagingConversation(row) && Object.hasOwn(aliases, row.key) ? { ...row, title: aliases[row.key] } : row, [aliases]);
  const displayListing = useMemo(() => listing ? { ...listing, sessions: listing.sessions.map(display) } : null, [listing, display]);
  const displaySelected = useMemo(() => selected ? display(selected) : null, [selected, display]);
  return { enabled: listing?.backend === "hermes", ready, listing: displayListing, filter, setFilter: updateFilter, selected: displaySelected,
    forget: (key: string) => { if (selected?.key === key) setSelected(null); void reload(); },
    seen, pins, setPinned, error, creating, lastCreatedKey, dialog, newChat, closeDialog, clear, select, selectKey, create, rename, reload };
}
export type HermesChatsController = ReturnType<typeof useHermesConversations>;
/** Awaiting human input outranks running; background = only subagents work; done means unseen output. */
export function chatStatus(row: HermesConversation, chats: Pick<HermesChatsController, "seen" | "selected">, streaming = false, awaiting = false, background = false): ChatStatus {
  if (awaiting || row.blocked) return "awaiting";
  if (streaming || row.working === true) return "running";
  if (background || row.background === true) return "background";
  if (chats.selected?.key !== row.key && row.updatedAt > (chats.seen[row.key] ?? row.updatedAt)) return "done";
  return "idle";
}
const DOT: Record<Exclude<ChatStatus, "idle">, { className: string; label: string }> = {
  running: { className: "bg-green-500 motion-safe:animate-pulse", label: "Running" },
  awaiting: { className: "bg-amber-500", label: "Needs your attention" },
  background: { className: "bg-[var(--color-chat-sidebar-muted)] opacity-60", label: "Subagents working" },
  done: { className: "bg-blue-500", label: "New activity" },
};
export function StatusDot({ status }: { status: ChatStatus }) {
  if (status === "idle") return null;
  return <span role="img" aria-label={DOT[status].label} title={DOT[status].label} className={`h-2 w-2 shrink-0 rounded-full ${DOT[status].className}`} />;
}
export function ParticipantIcons({ row }: { row: HermesConversation }) {
  return <span className="inline-flex shrink-0 -space-x-2" aria-label={`Participants: ${row.participants.map((p) => p.name).join(", ")}`}>
    {row.participants.slice(0, 2).map((p, index) => <span key={p.memberId || p.profile} className="rounded-full ring-2 ring-[var(--color-bg)]" style={{ zIndex: row.participants.length - index }} title={p.name}><ProfileAvatar name={p.profile} className={row.participants.length > 1 ? "h-5 w-5" : "h-6 w-6"} /></span>)}
  </span>;
}
function SourceIcon({ source }: { source: string }) {
  const Icon = source === "discord" ? FaDiscord : source === "whatsapp" ? FaWhatsapp : source === "group" ? Users : source === "pinned" ? Pin : source === "automation" ? Clock3 : source === "chats" ? MessageCircle : Hash;
  return <Icon size={12} aria-hidden="true" className="shrink-0" />;
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
export function HermesConversationList({ chats, workingKeys, awaitingKeys, backgroundKeys, onOpen }: { chats: HermesChatsController; workingKeys?: Set<string>; awaitingKeys?: Set<string>; backgroundKeys?: Set<string>; onOpen?: () => void }) {
  const rows = filterConversations(chats.listing?.sessions ?? [], chats.filter);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renamingNext = useRef(false);
  const [view, setView] = useState<ChatView>(DEFAULT_VIEW);
  const [query, setQuery] = useState("");
  useEffect(() => { setView(loadView()); }, []);
  const updateView = (next: ChatView) => {
    setView(next);
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* Keep filtering usable without storage. */ }
  };
  const result = applyChatView(rows, { ...view, pins: chats.pins ?? [] }, query);
  const reorderMotion = useConversationReorderMotion(result.sections, JSON.stringify([view, chats.pins, query, chats.filter, chats.ready]));

  const serverPins = chats.pins ?? [];
  const togglePin = (key: string) => void chats.setPinned(key, !serverPins.includes(key));
  const toggleSection = (key: string) => updateView({ ...view, collapsed: view.collapsed?.includes(key) ? view.collapsed.filter((id) => id !== key) : [...(view.collapsed ?? []), key] });
  return <motion.div layoutScroll className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-2 text-[var(--color-text)]" aria-label="Hermes conversations">
    <div className="flex items-center gap-1 pb-2">
      <input type="search" aria-label="Search chats" placeholder="Search chats" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1" />
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Filter and group chats" title="Filter and group" className="relative flex h-11 w-11 items-center justify-center rounded-md text-[var(--color-chat-sidebar-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline focus-visible:outline-2">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z" /></svg>
          {view.hidden.length > 0 && <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--color-text)]" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={styles.filterMenu}>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sort by</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={view.sortBy ?? "recent"} onValueChange={(value) => updateView({ ...view, sortBy: value === "project" ? "project" : "recent" })}>
              <DropdownMenuRadioItem value="recent">Most recent</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="project">Project</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
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

    {chats.error && <div role="alert" className="mb-2 rounded-md border border-[var(--color-border)] p-2 text-xs"><p>{chats.error}</p><button type="button" className="mt-1 min-h-9 underline focus-visible:outline focus-visible:outline-2" onClick={() => void chats.reload()}>Retry loading chats</button></div>}
    {chats.listing?.warnings.map((warning) => <p key={warning} role="status" className="text-[11px] p-2 text-amber-700">{warning}</p>)}
    {!chats.ready && <div role="status" aria-label="Loading chats" className="space-y-3 p-2 motion-safe:animate-pulse">{[0, 1, 2, 3].map((n) => <div key={n} className="h-9 rounded-md bg-[var(--color-surface-hover)]" />)}</div>}
    {result.sections.map((section) => <section key={section.key} aria-label={section.label ?? undefined}>
      <h3><button type="button" aria-label={`${section.label} ${section.rows.length}`} aria-expanded={!view.collapsed?.includes(section.key)} onClick={() => toggleSection(section.key)} className="flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-[11px] font-medium text-[var(--color-chat-sidebar-muted)] hover:bg-[var(--color-surface-hover)] focus-visible:outline focus-visible:outline-2">
        <ChevronRight size={12} aria-hidden="true" className={view.collapsed?.includes(section.key) ? "" : "rotate-90"} />
        <SourceIcon source={section.key} /><span className="min-w-0 flex-1 truncate text-left">{section.label}</span><span className="tabular-nums">{section.rows.length}</span>
      </button></h3>
      {!view.collapsed?.includes(section.key) && section.rows.map((row) => {
        const status = chatStatus(row, chats, workingKeys?.has(row.key), awaitingKeys?.has(row.key), backgroundKeys?.has(row.key));
        const pinned = serverPins.includes(row.key);
        const PinIcon = pinned ? PinOff : Pin;
        return <motion.div key={row.key} {...reorderMotion} data-conversation-key={row.key} data-status={status} data-selected={chats.selected?.key === row.key} className={`${styles.conversationRow} relative flex min-w-0 items-center rounded-lg ${status === "running" ? styles.running : ""}`}>
          <span className={`${styles.rowAvatar} flex h-11 w-11 shrink-0 items-center justify-center`}>{messagingConversation(row) ? <SourceIcon source={row.source!} /> : <ParticipantIcons row={row} />}</span>
          <div className="min-w-0 flex-1">
            {renaming === row.key ? <RenameInput initial={row.title} onCancel={() => setRenaming(null)} onSubmit={async (title) => { const ok = await chats.rename(row, title); if (ok) setRenaming(null); return ok; }} /> :
            <button type="button" aria-label={`Open ${row.title}`} title={row.title} onClick={() => { chats.select(row); onOpen?.(); }} onDoubleClick={() => setRenaming(row.key)} aria-current={chats.selected?.key === row.key ? "true" : undefined} className="block min-h-11 w-full min-w-0 touch-manipulation rounded-md py-1.5 text-left focus-visible:outline focus-visible:outline-2">
              <span className="block truncate text-[12px] font-medium">{row.title}</span>
              <span className="block truncate text-[9px] text-[var(--color-chat-sidebar-muted)]">{[formatChatDate(row.updatedAt), view.sortBy === "project" ? row.project || "No project" : "", section.key === "pinned" ? conversationChannel(row).label : "", automation(row) ? "read-only" : ""].filter(Boolean).join(" · ")}</span>
            </button>}
          </div>
          <span className="ml-1 flex w-3 shrink-0 justify-center"><StatusDot status={status} /></span>
          <button type="button" aria-label={`${pinned ? "Unpin" : "Pin"} ${row.title}`} title={pinned ? "Unpin chat" : "Pin chat"} aria-pressed={pinned} onClick={() => togglePin(row.key)} className={`${styles.rowPin} flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--color-chat-sidebar-muted)] focus-visible:outline focus-visible:outline-2`}><PinIcon size={15} aria-hidden="true" /></button>
          {renaming !== row.key && <DropdownMenu>
            <DropdownMenuTrigger aria-label={`More options for ${row.title}`} title="More options" className={`${styles.rowRename} flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--color-chat-sidebar-muted)] focus-visible:outline focus-visible:outline-2`}><MoreVertical size={14} aria-hidden="true" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" finalFocus={() => { if (!renamingNext.current) return true; renamingNext.current = false; return false; }}>
              <DropdownMenuItem onSelect={() => { renamingNext.current = true; setRenaming(row.key); }}><Pencil size={14} aria-hidden="true" />{messagingConversation(row) ? "Rename in this browser" : "Rename"}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(row.id); }}><Copy size={14} aria-hidden="true" />Copy ID</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>}
        </motion.div>;
      })}
    </section>)}
    {chats.ready && !chats.error && !result.shown && <div className="p-3 text-xs text-[var(--color-chat-sidebar-muted)]"><p>{rows.length ? "No conversations match this view." : `No conversations${chats.filter ? ` for ${chats.filter}` : ""} yet.`}</p>{(query || view.hidden.length > 0) && <button type="button" className="mt-1 min-h-9 underline focus-visible:outline focus-visible:outline-2" onClick={() => { setQuery(""); updateView({ ...view, hidden: [] }); }}>Clear search and source filters</button>}</div>}
  </motion.div>;
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
