"use client";

const FALLBACK_ICON = "/rebattery-app-192.png";
const PREFS_KEY = "denchclaw:notification-prefs";

export type NotificationKind = "start" | "done" | "input";
export interface NotificationPrefs { start: boolean; done: boolean; input: boolean }

export function readNotificationPrefs(): NotificationPrefs {
  const defaults = { start: true, done: true, input: true };
  if (typeof localStorage === "undefined") return defaults;
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; } catch { return defaults; }
}

export function writeNotificationPrefs(prefs: NotificationPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
  void syncPushPrefs(prefs);
}

const PUSH_FLAG_KEY = "denchclaw:push-subscribed";
/** True when this device is subscribed to server push, which then delivers done/input even with the app closed. */
export function pushActive(): boolean {
  try { return localStorage.getItem(PUSH_FLAG_KEY) === "1"; } catch { return false; }
}
function setPushActive(on: boolean): void {
  try { if (on) { localStorage.setItem(PUSH_FLAG_KEY, "1"); } else { localStorage.removeItem(PUSH_FLAG_KEY); } } catch { /* storage unavailable */ }
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) { out[i] = raw.charCodeAt(i); }
  return out;
}

async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) { return null; }
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

async function uploadSubscription(sub: PushSubscription, prefs: NotificationPrefs): Promise<boolean> {
  const response = await fetch("/api/push/subscription", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), prefs: { done: prefs.done, input: prefs.input } }),
  });
  return response.ok;
}

/** Subscribe this device to server push (needs granted permission). Returns false when push is unavailable. */
export async function enablePush(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") { return false; }
  try {
    await registerServiceWorker();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const keyResponse = await fetch("/api/push/subscription");
      if (!keyResponse.ok) { return false; }
      const { publicKey } = await keyResponse.json() as { publicKey: string };
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    }
    const ok = await uploadSubscription(sub, readNotificationPrefs());
    setPushActive(ok);
    return ok;
  } catch { return false; }
}

export async function disablePush(): Promise<void> {
  setPushActive(false);
  try {
    const sub = await currentPushSubscription();
    if (!sub) { return; }
    await fetch("/api/push/subscription", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  } catch { /* the server drops dead endpoints itself */ }
}

/** Keep the server's copy of this device's prefs and keys current. */
export async function syncPushPrefs(prefs: NotificationPrefs = readNotificationPrefs()): Promise<void> {
  if (!pushActive()) { return; }
  try {
    const sub = await currentPushSubscription();
    if (!sub) { setPushActive(false); return; }
    await uploadSubscription(sub, prefs);
  } catch { /* retried on the next load */ }
}

/** Ask the server to push a test to this device, which proves the closed-app path. */
export async function sendTestPush(): Promise<boolean> {
  try {
    const sub = await currentPushSubscription();
    if (!sub) { return false; }
    const response = await fetch("/api/push/subscription", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    return response.ok;
  } catch { return false; }
}

/** iPhone/iPad web push only works once the site is added to the Home Screen. */
export function isIos(): boolean {
  return typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);
}
export function isStandalone(): boolean {
  return typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
}

export interface AgentNotification {
  kind?: NotificationKind;
  title: string;
  body: string;
  icon?: string;
  tag: string;
  url?: string;
}

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** True when the user is not looking at the app, so a notification adds information. */
export function appIsBackgrounded(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch { /* notifications fall back to Notification */ }
}

export async function showAgentNotification(n: AgentNotification): Promise<void> {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (n.kind && !readNotificationPrefs()[n.kind]) return;
  // Subscribed devices get finished/needs-input from the server, even with the app closed; skip the in-page copy.
  if ((n.kind === "done" || n.kind === "input") && pushActive()) return;
  const options: NotificationOptions & { renotify?: boolean } = {
    body: n.body,
    icon: n.icon || FALLBACK_ICON,
    badge: FALLBACK_ICON,
    tag: n.tag,
    data: { url: n.url ?? "/" },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    if (reg) { await reg.showNotification(n.title, options); return; }
  } catch { /* fall through */ }
  try { new Notification(n.title, options); } catch { /* unsupported context */ }
}
