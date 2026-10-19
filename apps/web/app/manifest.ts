import type { MetadataRoute } from "next";

// Installation metadata only. Private pages and API responses stay network-only;
// this application deliberately does not register a caching service worker.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ReBattery CRM",
    short_name: "ReBattery CRM",
    description: "ReBattery's private CRM and DenchClaw AI workspace.",
    lang: "en",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f5f5f4",
    theme_color: "#f5f5f4",
    prefer_related_applications: false,
    icons: [
      {
        src: "/rebattery-app-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/rebattery-app-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/rebattery-app-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
