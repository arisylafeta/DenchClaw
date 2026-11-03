import { queryPg } from "@/lib/postgres";
import { listConversations } from "@/lib/hermes-native";
import { conversationTransition, type ConversationSeen } from "@/lib/hermes-chat/conversation-transitions";
import { bundledProfileAvatar } from "@/lib/profile-avatars";
import { sendPushToUser, vapidConfig, type PushPayload } from "@/lib/web-push";

const INTERVAL_MS = 15_000;

type Row = {
  key: string; title?: string; profile?: string; source?: string; working?: boolean; blocked?: boolean;
  participants?: Array<{ profile?: string }>; access?: { ownerId: string | null } | null;
};

/** The push a listing refresh earns for one of the user's own chats, or null. Exported for tests. */
export function pushFor(userId: string, was: ConversationSeen | undefined, row: Row): PushPayload | null {
  const kind = conversationTransition(was, row);
  if (!kind || row.access?.ownerId !== userId) { return null; }
  const profile = row.profile ?? row.participants?.[0]?.profile;
  return {
    kind,
    title: row.title || profile || "ReBattery CRM",
    body: kind === "input" ? "Waiting for your input" : "Finished",
    // Only bundled avatars: the OS fetches the icon without the session cookie.
    icon: profile ? bundledProfileAvatar(profile) : undefined,
    tag: `agent-${row.key}`,
    chat: row.key,
    url: `/?chat=${encodeURIComponent(row.key)}`,
  };
}

const seen = new Map<string, Map<string, ConversationSeen>>();

export async function watchOnce(): Promise<void> {
  if (!vapidConfig()) { return; }
  const users = await queryPg<{ id: string; email: string; display_name: string }>(
    `select distinct u.id, u.email, u.display_name from crm_push_subscriptions s
       join crm_users u on u.id = s.user_id and u.is_active`,
  );
  const live = new Set(users.map((u) => u.id));
  for (const id of seen.keys()) { if (!live.has(id)) { seen.delete(id); } }
  for (const user of users) {
    try {
      const listing = await listConversations({ id: user.id, email: user.email, displayName: user.display_name });
      const before = seen.get(user.id);
      const next = new Map<string, ConversationSeen>();
      for (const row of listing.sessions as unknown as Row[]) {
        next.set(row.key, { working: row.working === true, blocked: row.blocked === true });
        // First pass only records state, so a deploy or restart never replays old finishes.
        const payload = before ? pushFor(user.id, before.get(row.key), row) : null;
        if (payload) { await sendPushToUser(user.id, payload); }
      }
      seen.set(user.id, next);
    } catch (error) { console.error("[push-watcher] user pass failed", (error as Error).message); }
  }
}

/** Server-side edge detection for chats, so finished/blocked chats notify devices whose app is closed. */
export function startPushWatcher(): void {
  const g = globalThis as { __denchPushWatcher?: boolean };
  if (g.__denchPushWatcher) { return; }
  g.__denchPushWatcher = true;
  let running = false;
  setInterval(() => {
    if (running) { return; }
    running = true;
    void watchOnce().catch((error) => console.error("[push-watcher]", (error as Error).message)).finally(() => { running = false; });
  }, INTERVAL_MS).unref();
}
