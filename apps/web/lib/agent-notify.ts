"use client";

const FALLBACK_ICON = "/rebattery-app-192.png";
const PREFS_KEY = "denchclaw:notification-prefs";

export type NotificationKind = "start" | "done";
export interface NotificationPrefs { start: boolean; done: boolean }

export function readNotificationPrefs(): NotificationPrefs {
  const defaults = { start: true, done: true };
  if (typeof localStorage === "undefined") return defaults;
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; } catch { return defaults; }
}

export function writeNotificationPrefs(prefs: NotificationPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* storage unavailable */ }
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
