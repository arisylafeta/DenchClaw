// Client-safe identities. Profile filters never participate in routing a selected chat.
export type HermesParticipant = { profile: string; memberId?: string; name: string; handle?: string };
export type ConversationAccess = { visibility: "private" | "team"; ownerId: string | null; canShare: boolean; canDelete: boolean; canWrite: boolean; canApprove: boolean };
export type HermesConversation = {
  access?: ConversationAccess;
  key: string;
  kind: "solo" | "group";
  id: string;
  profile?: string;
  title: string;
  /** Safe leaf label from explicit session project metadata, never a raw path. */
  project?: string;
  updatedAt: number;
  participants: HermesParticipant[];
  working: boolean | null;
  /** The chat's own turn is done but its background subagents are still working. */
  background?: boolean | null;
  /** Hermes session source for solo chats (cron, webhook, discord, desktop, …). */
  source?: string;
  /** Group needs attention in Hermes (approval, retry or cancellation). */
  blocked?: boolean | null;
};
export type HermesMessage = { memberId?: string; turnId?: string; taskId?: string; createdAt?: number; id: string; role: string; timestamp?: number; displayKind?: string; displayMetadata?: unknown; text: string; content?: string; parts?: Record<string, unknown>[]; profile?: string; name?: string };
export function conversationKey(kind: "solo" | "group", id: string, profile = ""): string {
  return encodeURIComponent(JSON.stringify([kind, profile, id]));
}
export function parseConversationKey(key: string): { kind: "solo" | "group"; profile: string; id: string } {
  const value: unknown = JSON.parse(decodeURIComponent(key));
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === "string") ||
      !["solo", "group"].includes(value[0]) || !value[2] || (value[0] === "solo" && !value[1])) {
    throw new Error("Invalid conversation identity");
  }
  return { kind: value[0] as "solo" | "group", profile: value[1], id: value[2] };
}
/** Strictly validated server access metadata. Anything missing or malformed grants nothing. */
export function parseConversationAccess(value: unknown): ConversationAccess | null {
  if (!value || typeof value !== "object") { return null; }
  const v = value as Record<string, unknown>;
  if ((v.visibility !== "private" && v.visibility !== "team") || (v.ownerId !== null && typeof v.ownerId !== "string")) { return null; }
  if (![v.canShare, v.canDelete, v.canWrite, v.canApprove].every((flag) => typeof flag === "boolean")) { return null; }
  return { visibility: v.visibility, ownerId: v.ownerId, canShare: v.canShare as boolean, canDelete: v.canDelete as boolean, canWrite: v.canWrite as boolean, canApprove: v.canApprove as boolean };
}
export function canViewConversation(row: HermesConversation, userId?: string | null): boolean {
  return !!row.access && (row.access.visibility === "team" || (!!userId && row.access.visibility === "private" && row.access.ownerId === userId));
}
export function filterConversations(rows: HermesConversation[], profile: string | null) {
  return profile ? rows.filter((row) => row.participants.some((p) => p.profile === profile)) : rows;
}

/** Where a chat came from. Hermes sets `source` on every session; scheduled runs use `cron`. */
const CHANNEL_LABELS: Record<string, string> = {
  cron: "Scheduled", webhook: "Webhook", crm: "CRM", api_server: "CRM / API", discord: "Discord", whatsapp: "WhatsApp", telegram: "Telegram",
  slack: "Slack", ios: "iOS", desktop: "Desktop", cli: "CLI", tui: "Terminal", group: "Groups", other: "Other",
};
export function conversationChannel(row: HermesConversation): { id: string; label: string } {
  const id = row.kind === "group" ? "group" : row.source || "other";
  return { id, label: Object.hasOwn(CHANNEL_LABELS, id) ? CHANNEL_LABELS[id] : id.charAt(0).toUpperCase() + id.slice(1) };
}
export function automation(row: HermesConversation): boolean {
  return row.kind === "solo" && (row.source === "cron" || row.source === "webhook");
}
/** Scheduled runs are titled "<job name> · <time>"; the job name groups repeated runs. */
function scheduledJob(row: HermesConversation) {
  return row.source === "cron" ? row.title.split(" · ")[0] : conversationChannel(row).label;
}
export type GroupBy = "source" | "none" | "channel" | "agent" | "day" | "job";
export type SortBy = "recent" | "project";
export type ChatView = { hidden: string[]; groupBy: GroupBy; sortBy?: SortBy; version?: 2; pins?: string[]; collapsed?: string[] };
/** Automation is discoverable, but closed until deliberately opened. */
export const DEFAULT_VIEW: ChatView = { version: 2, hidden: [], groupBy: "source", sortBy: "recent", pins: [], collapsed: ["automation"] };
export type ChatSection = { key: string; label: string | null; rows: HermesConversation[] };
const MESSAGING = new Set(["discord", "whatsapp", "telegram", "slack", "signal", "matrix", "mattermost", "sms", "email"]);
export function messagingConversation(row: HermesConversation) { return row.kind === "solo" && MESSAGING.has(row.source ?? ""); }
export function sourceSection(row: HermesConversation) {
  if (automation(row)) return { key: "automation", label: "Automation" };
  if (row.kind === "group") return { key: "group", label: "Groups" };
  if (messagingConversation(row) || (row.source && !["web", "crm", "api_server", "desktop", "cli", "tui", "ios", "other"].includes(row.source))) {
    const channel = conversationChannel(row); return { key: messagingConversation(row) ? channel.id : `source:${channel.id}`, label: channel.label };
  }
  return { key: "chats", label: "Chats" };
}
export function parseChatView(value: unknown): ChatView {
  if (!value || typeof value !== "object") return { ...DEFAULT_VIEW };
  const v = value as Record<string, unknown>;
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.length <= 5000 && item.every((id) => typeof id === "string" && id.length <= 2000);
  if (!strings(v.hidden) || !["source", "none", "channel", "agent", "day", "job"].includes(String(v.groupBy))) return { ...DEFAULT_VIEW };
  return { version: 2, hidden: [...new Set(v.hidden)], groupBy: v.groupBy === "none" ? "source" : v.groupBy as GroupBy,
    sortBy: v.sortBy === "project" ? "project" : "recent",
    pins: strings(v.pins) ? [...new Set(v.pins)] : [], collapsed: strings(v.collapsed) ? [...new Set(v.collapsed)] : ["automation"] };
}
function dayBucket(ms: number, now: Date) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) return "Today";
  const days = Math.ceil((startOfToday - ms) / 86_400_000);
  return days === 1 ? "Yesterday" : days <= 7 ? "Last 7 days" : days <= 30 ? "Last 30 days" : "Older";
}
export function applyChatView(rows: HermesConversation[], view: ChatView, query: string, now = new Date(), userId?: string) {
  const needle = query.trim().toLowerCase();
  const unique = [...new Map(rows.filter((row) => canViewConversation(row, userId)).map((row) => [row.key, row])).values()];
  const searched = needle ? unique.filter((row) => row.title.toLowerCase().includes(needle) || row.participants.some((p) => p.name.toLowerCase().includes(needle))) : unique;
  const counts: Record<string, { id: string; label: string; count: number }> = Object.create(null);
  for (const row of searched) { const c = conversationChannel(row); (counts[c.id] ??= { ...c, count: 0 }).count++; }
  for (const id of view.hidden) counts[id] ??= { id, label: Object.hasOwn(CHANNEL_LABELS, id) ? CHANNEL_LABELS[id] : id, count: 0 };
  const shown = searched.filter((row) => !view.hidden.includes(conversationChannel(row).id));
  const keyOf = (row: HermesConversation) => view.groupBy === "channel" ? conversationChannel(row).label
    : view.groupBy === "agent" ? (row.kind === "group" ? "Groups" : row.profile ?? "Other")
    : view.groupBy === "day" ? dayBucket(row.updatedAt, now) : scheduledJob(row);
  const sections = new Map<string, ChatSection>();
  const pins = new Set(view.pins ?? []);
  const recentFirst = (a: HermesConversation, b: HermesConversation) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key);
  // Discover sections in recency order regardless of the row sort preference.
  const sorted = [...shown].sort(recentFirst);
  for (const row of sorted) {
    const scope = row.access?.visibility === "team" ? "shared" : "mine";
    const detail = automation(row) ? sourceSection(row) : view.groupBy === "source" || view.groupBy === "none"
      ? sourceSection(row) : { key: `view:${keyOf(row)}`, label: keyOf(row) };
    const base = scope === "mine" ? "My chats" : "Shared";
    const bucket = pins.has(row.key) ? { key: "pinned", label: "Pinned" }
      : automation(row) ? { key: "automation", label: `${base} · Automation` }
      : detail.key === "chats" || detail.key === "group" ? { key: scope, label: base }
      : { key: `${scope}:${detail.key}`, label: `${base} · ${detail.label}` };
    const section = sections.get(bucket.key) ?? { ...bucket, rows: [] };
    section.rows.push(row); sections.set(bucket.key, section);
  }
  if (view.sortBy === "project") for (const section of sections.values()) {
    section.rows.sort((a, b) => Number(!a.project) - Number(!b.project)
      || (a.project ?? "").localeCompare(b.project ?? "", undefined, { sensitivity: "base" }) || recentFirst(a, b));
  }
  const order = ["pinned", "mine", "shared"];
  const rank = (key: string) => key === "automation" ? 1000 : order.includes(key) ? order.indexOf(key) : key.startsWith("mine:") ? 1.5 : 3;
  return { sections: [...sections.values()].sort((a, b) => rank(a.key) - rank(b.key)), channels: Object.values(counts).sort((a, b) => b.count - a.count), shown: shown.length, hiddenCount: searched.length - shown.length };
}
