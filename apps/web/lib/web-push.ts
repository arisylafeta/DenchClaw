import { readFileSync } from "node:fs";
import webpush from "web-push";
import { queryPg } from "@/lib/postgres";

export type PushKind = "done" | "input";
export type PushPrefs = Record<PushKind, boolean>;
export type PushPayload = { kind?: PushKind; title: string; body: string; icon?: string; tag: string; url: string };
export type PushSubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

const DEFAULT_PREFS: PushPrefs = { done: true, input: true };
const SECRET_PATH = process.env.DENCH_WEB_PUSH_FILE || "/root/.hermes/workspace/secrets/dench-web-push.json";

type Vapid = { publicKey: string; privateKey: string; subject: string };
let vapid: Vapid | null | undefined;

/** VAPID keys live in a 0600 file outside the repo. Missing or malformed means push is off, never a crash. */
export function vapidConfig(): Vapid | null {
  if (vapid !== undefined) { return vapid; }
  try {
    const raw = JSON.parse(readFileSync(SECRET_PATH, "utf8")) as Partial<Vapid>;
    vapid = raw.publicKey && raw.privateKey && raw.subject ? { publicKey: raw.publicKey, privateKey: raw.privateKey, subject: raw.subject } : null;
  } catch { vapid = null; }
  return vapid;
}
export function resetVapidForTests() { vapid = undefined; }

export function pushPublicKey(): string | null { return vapidConfig()?.publicKey ?? null; }

export function parsePrefs(value: unknown): PushPrefs {
  const v = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return { done: v.done !== false, input: v.input !== false };
}

export function parseSubscription(value: unknown): PushSubscriptionInput | null {
  if (!value || typeof value !== "object") { return null; }
  const v = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const { endpoint } = v;
  const p256dh = v.keys?.p256dh;
  const auth = v.keys?.auth;
  if (typeof endpoint !== "string" || endpoint.length > 2000 || !/^https:\/\//.test(endpoint)) { return null; }
  if (typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) { return null; }
  return { endpoint, keys: { p256dh, auth } };
}

export async function saveSubscription(userId: string, sub: PushSubscriptionInput, prefs: PushPrefs, userAgent: string | null) {
  // The endpoint is the device's identity: re-subscribing after a sign-in as someone else moves it to the new user.
  await queryPg(
    `insert into crm_push_subscriptions (endpoint, user_id, p256dh, auth, prefs, user_agent)
     values ($1, $2, $3, $4, $5::jsonb, $6)
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       prefs = excluded.prefs, user_agent = excluded.user_agent, last_seen_at = now()`,
    [sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, JSON.stringify(prefs), userAgent?.slice(0, 300) ?? null],
  );
}

export async function removeSubscription(userId: string, endpoint: string) {
  await queryPg("delete from crm_push_subscriptions where endpoint = $1 and user_id = $2", [endpoint, userId]);
}

type SubRow = { endpoint: string; p256dh: string; auth: string; prefs: unknown };

/** Sends to every device of the user whose prefs allow the kind. Dead endpoints (404/410) are removed. Returns the number delivered. */
export async function sendPushToUser(userId: string, payload: PushPayload, only?: { endpoint: string }): Promise<number> {
  const config = vapidConfig();
  if (!config) { return 0; }
  const rows = await queryPg<SubRow>(
    "select endpoint, p256dh, auth, prefs from crm_push_subscriptions where user_id = $1" + (only ? " and endpoint = $2" : ""),
    only ? [userId, only.endpoint] : [userId],
  );
  let delivered = 0;
  await Promise.all(rows.map(async (row) => {
    if (payload.kind && !parsePrefs(row.prefs)[payload.kind]) { return; }
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify(payload),
        { vapidDetails: config, TTL: 60 * 60, urgency: "high", topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined },
      );
      delivered += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) { await queryPg("delete from crm_push_subscriptions where endpoint = $1", [row.endpoint]).catch(() => {}); }
      else { console.error("[web-push] send failed", status ?? (error as Error).message); }
    }
  }));
  return delivered;
}
