import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { refreshSessionTokenMock } = vi.hoisted(() => ({
  refreshSessionTokenMock: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  refreshSessionToken: refreshSessionTokenMock,
}));
vi.mock("@/lib/telemetry", () => ({}));
vi.mock("./components/posthog-provider", () => ({}));
vi.mock("./components/platform-admin/ui/sonner", () => ({}));
vi.mock("next-themes", () => ({}));

import manifest from "./manifest";
import { metadata, viewport } from "./layout";
import { middleware } from "../middleware";

const publicDir = path.resolve(import.meta.dirname, "../public");
const app = manifest();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function verifyPng(src: string, size: number) {
  const png = readFileSync(path.join(publicDir, src));
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.subarray(12, 16).toString()).toBe("IHDR");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  expect(png[24]).toBe(8); // 8-bit RGB, opaque, non-interlaced.
  expect(png[25]).toBe(2);
  expect(png[28]).toBe(0);
  const data: Buffer[] = [];
  let ended = false;
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const payload = png.subarray(offset + 8, offset + 8 + length);
    expect(crc32(png.subarray(offset + 4, offset + 8 + length)))
      .toBe(png.readUInt32BE(offset + 8 + length));
    if (type === "IDAT") data.push(payload);
    if (type === "IEND") ended = true;
    offset += length + 12;
    if (ended) expect(offset).toBe(png.length);
  }
  expect(ended).toBe(true);
  const rows = inflateSync(Buffer.concat(data));
  const stride = size * 3;
  expect(rows).toHaveLength((stride + 1) * size);
  // Decode PNG RGB row filters so the maskable safe area is checked against
  // actual artwork pixels, not just a purpose label or advertised dimensions.
  const pixels = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    const filter = rows[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 3 ? pixels[index - 3] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 3 ? pixels[index - stride - 3] : 0;
      const prediction = left + above - upperLeft;
      const distances = [left, above, upperLeft].map((value) => Math.abs(prediction - value));
      const paeth = [left, above, upperLeft][distances.indexOf(Math.min(...distances))];
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      pixels[index] = rows[y * (stride + 1) + x + 1] + predictor;
    }
  }
  return pixels;
}

describe("private-workspace PWA foundation", () => {
  it("has one Next manifest with a stable, same-origin standalone launch", () => {
    expect(app).toMatchObject({
      id: "/", name: "ReBattery CRM", short_name: "ReBattery CRM",
      start_url: "/", scope: "/", display: "standalone", lang: "en",
      background_color: "#f5f5f4", theme_color: "#f5f5f4",
      prefer_related_applications: false,
    });
    const origin = "https://crm.example.test";
    expect(new URL(app.start_url!, origin).origin).toBe(origin);
    expect(new URL(app.start_url!, origin).pathname.startsWith(app.scope!)).toBe(true);
    expect(readdirSync(import.meta.dirname).filter((name) => /^manifest\./.test(name)))
      .toEqual(["manifest.ts"]);
    expect(readdirSync(publicDir).filter((name) => /^manifest\./.test(name))).toEqual([]);
  });

  it.each([192, 512])("advertises a real opaque %i-pixel installation PNG", (size) => {
    const icon = app.icons!.find((item) => item.sizes === `${size}x${size}` && item.purpose === "any")!;
    expect(icon.type).toBe("image/png");
    verifyPng(icon.src, size);
  });

  it("provides a separate opaque maskable PNG", () => {
    const icon = app.icons!.find((item) => item.purpose === "maskable")!;
    expect(icon).toMatchObject({ type: "image/png", sizes: "512x512" });
    const pixels = verifyPng(icon.src, 512);
    let artworkPixels = 0;
    let outsideSafeArea = 0;
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const rgb = pixels.subarray((y * 512 + x) * 3, (y * 512 + x) * 3 + 3);
        if (rgb.equals(Buffer.from([231, 243, 70]))) continue;
        artworkPixels++;
        if (Math.hypot(x + 0.5 - 256, y + 0.5 - 256) > 512 * 0.4) outsideSafeArea++;
      }
    }
    expect(artworkPixels).toBeGreaterThan(0);
    expect(outsideSafeArea).toBe(0);
  });

  it("keeps branding consistent and supplies an actual Apple PNG", () => {
    expect(metadata.title).toBe(app.name);
    expect(metadata.applicationName).toBe(app.name);
    expect(metadata.description).toBe(app.description);
    expect(metadata.appleWebApp).toEqual({ capable: true, title: app.name, statusBarStyle: "default" });
    expect(metadata.icons).toEqual({
      icon: "/rebattery-favicon.svg",
      apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    });
    verifyPng("/apple-touch-icon.png", 180);
  });

  it("allows user zoom and exposes safe-area/keyboard-aware viewport settings", () => {
    expect(viewport).toMatchObject({
      width: "device-width", initialScale: 1, viewportFit: "cover",
      interactiveWidget: "resizes-content",
    });
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).not.toBe(false);
    expect(viewport.themeColor).toEqual([
      { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
      { media: "(prefers-color-scheme: dark)", color: "#222222" },
    ]);
  });

  it.each(["/manifest.webmanifest", "/apple-touch-icon.png", ...app.icons!.map((item) => item.src)])
    ("serves branding resource %s without a private session", async (resource) => {
      const response = await middleware(new NextRequest(`https://crm.example.test${resource}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

  it.each(["/", "/workspace", "/manifest.webmanifest/private", "/rebattery-app-512.png/private"])
    ("does not extend installation exceptions to private navigation %s", async (resource) => {
      const response = await middleware(new NextRequest(`https://crm.example.test${resource}`));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
    });

  it.each(["/", "/workspace", "/api/hermes/events", "/api/workspace/file?path=private.md"])
    ("keeps authenticated response %s private and uncached", async (resource) => {
      refreshSessionTokenMock.mockResolvedValueOnce({ id: "synthetic-user" });
      const response = await middleware(new NextRequest(`https://crm.example.test${resource}`, {
        headers: { cookie: "denchclaw_session=synthetic-session" },
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
    });
});
