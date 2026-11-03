// Notification-only service worker: no caching, private pages stay network-only.
// Server Web Push shows finished / needs-input notices even when the app is closed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "ReBattery CRM", body: event.data ? event.data.text() : "" }; }
  event.waitUntil((async () => {
    // A focused, visible window already shows the chat. iOS requires every push to display a notice, so it never skips.
    const ios = /iphone|ipad|ipod/i.test(self.navigator.userAgent);
    if (!ios && data.tag !== "test") {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (all.some((c) => c.visibilityState === "visible" && c.focused)) return;
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
