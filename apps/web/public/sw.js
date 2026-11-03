// Notification-only service worker: no caching, private pages stay network-only.
// Server Web Push shows finished / needs-input notices even when the app is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "ReBattery CRM", body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    // Skip only when a focused window already shows THIS chat. Apple browsers (iPhone, iPad, Mac) revoke
    // subscriptions that receive pushes without a notice, so they always display.
    const apple = /iphone|ipad|ipod|macintosh/i.test(self.navigator.userAgent);
    if (!apple && data.chat) {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const needle = encodeURIComponent(data.chat);
      if (all.some((c) => c.visibilityState === "visible" && c.focused && (c.url.includes(needle) || c.url.includes(data.chat)))) return;
    }
    await self.registration.showNotification(data.title || "ReBattery CRM", {
      body: data.body || "",
      icon: data.icon || "/rebattery-app-192.png",
      badge: "/rebattery-app-192.png",
      tag: data.tag || "agent",
      renotify: true,
      data: { url: data.url || "/" },
    });
  })());
});
// The browser rotated the subscription: register the new one (the server keeps the device's prefs when none are sent).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription;
      const sub = event.newSubscription || (old && await self.registration.pushManager.subscribe(old.options));
      if (!sub) return;
      await fetch("/api/push/subscription", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch {}
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if ("focus" in client) {
        await client.focus();
        if ("navigate" in client && target !== "/") { try { await client.navigate(target); } catch {} }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
