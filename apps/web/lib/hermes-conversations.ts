// Client-safe identities. Profile filters never participate in routing a selected chat.
export type HermesParticipant = { profile: string; memberId?: string; name: string; handle?: string };
export type HermesConversation = {
  key: string;
  kind: "solo" | "group";
  id: string;
  profile?: string;
  title: string;
  updatedAt: number;
  participants: HermesParticipant[];
  working: boolean | null;
  /** Hermes session source for solo chats (cron, webhook, discord, desktop, …). */
  source?: string;
  /** Group needs attention in Hermes (approval, retry or cancellation). */
  blocked?: boolean;
};
export type HermesMessage = { id: string; role: string; text: string; content?: string; parts?: Record<string, unknown>[]; profile?: string; name?: string };
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
  return { id, label: CHANNEL_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1) };
}
export function automation(row: HermesConversation): boolean {
  return row.kind === "solo" && (row.source === "cron" || row.source === "webhook");
}
/** Scheduled runs are titled "<job name> · <time>"; the job name groups repeated runs. */
function scheduledJob(row: HermesConversation) {
  return row.source === "cron" ? row.title.split(" · ")[0] : conversationChannel(row).label;
}
export type GroupBy = "none" | "channel" | "agent" | "day" | "job";
export type ChatView = { hidden: string[]; groupBy: GroupBy };
/** Unattended automation starts hidden, but remains available in the channel menu. */
export const DEFAULT_VIEW: ChatView = { hidden: ["cron", "webhook"], groupBy: "none" };
export type ChatSection = { key: string; label: string | null; rows: HermesConversation[] };
function dayBucket(ms: number, now: Date) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= startOfToday) return "Today";
  const days = Math.ceil((startOfToday - ms) / 86_400_000);
  return days === 1 ? "Yesterday" : days <= 7 ? "Last 7 days" : days <= 30 ? "Last 30 days" : "Older";
}
export function applyChatView(rows: HermesConversation[], view: ChatView, query: string, now = new Date()) {
  const needle = query.trim().toLowerCase();
  const searched = needle ? rows.filter((row) => row.title.toLowerCase().includes(needle) || row.participants.some((p) => p.name.toLowerCase().includes(needle))) : rows;
  const counts: Record<string, { id: string; label: string; count: number }> = {};
  for (const row of searched) { const c = conversationChannel(row); (counts[c.id] ??= { ...c, count: 0 }).count++; }
  for (const id of view.hidden) counts[id] ??= { id, label: CHANNEL_LABELS[id] ?? id, count: 0 };
  const shown = searched.filter((row) => !view.hidden.includes(conversationChannel(row).id));
  const keyOf = (row: HermesConversation) => view.groupBy === "channel" ? conversationChannel(row).label
    : view.groupBy === "agent" ? (row.kind === "group" ? "Groups" : row.profile ?? "Other")
    : view.groupBy === "day" ? dayBucket(row.updatedAt, now) : scheduledJob(row);
  const sections = new Map<string, ChatSection>();
  for (const row of shown) {
    const label = view.groupBy === "none" ? null : keyOf(row);
    const section = sections.get(label ?? "") ?? { key: label ?? "", label, rows: [] };
    section.rows.push(row); sections.set(label ?? "", section);
  }
  return { sections: [...sections.values()], channels: Object.values(counts).sort((a, b) => b.count - a.count), shown: shown.length, hiddenCount: searched.length - shown.length };
}
