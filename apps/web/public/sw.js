// Notification-only service worker: no caching, private pages stay network-only.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
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
