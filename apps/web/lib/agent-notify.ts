"use client";

const FALLBACK_ICON = "/rebattery-app-192.png";

export interface AgentNotification {
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

/** Ask once, from a user gesture, as browsers require. */
export function requestPermissionOnFirstGesture(): () => void {
  if (!notificationsSupported() || Notification.permission !== "default") return () => {};
  const ask = () => { void Notification.requestPermission(); cleanup(); };
  const cleanup = () => {
    window.removeEventListener("pointerdown", ask);
    window.removeEventListener("keydown", ask);
  };
  window.addEventListener("pointerdown", ask, { once: true });
  window.addEventListener("keydown", ask, { once: true });
  return cleanup;
}
