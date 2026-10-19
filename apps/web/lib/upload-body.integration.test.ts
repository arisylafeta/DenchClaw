import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/auth", () => ({
  refreshSessionToken: async () => { await new Promise(resolve => setTimeout(resolve, 1)); return true; },
  sessionCookie: () => ({ name: "denchclaw_session", value: "synthetic" }),
}));
vi.mock("@/lib/workspace", () => ({
  resolveWorkspaceRoot: () => state.root,
  safeResolveNewPath: (path: string) => join(state.root, path),
}));
vi.mock("@/lib/telemetry", () => ({ trackServer: vi.fn() }));
import { middleware } from "../middleware";
import { POST } from "../app/api/workspace/upload/route";

// Use the installed framework's actual cloning and route-adapter machinery.
const require = createRequire(import.meta.url);
const { getCloneableBody } = require("next/dist/server/body-streams");
const { NodeNextRequest } = require("next/dist/server/base-http/node");
const { NextRequestAdapter } = require("next/dist/server/web/spec-extension/adapters/next-request");
afterEach(() => { if (state.root) rmSync(state.root, { recursive: true, force: true }); });

describe("Node middleware to upload route body handoff", () => {
  it.each([0, 2 * 1024 * 1024, 25 * 1024 * 1024, 25 * 1024 * 1024 + 1])("preserves multipart bytes through middleware while the network body is arriving (file bytes: %s)", async (size) => {
    state.root = mkdtempSync(join(tmpdir(), "upload-body-"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
    const payload = size ? Buffer.concat([png, Buffer.alloc(size - png.length)]) : png;
    const form = new FormData();
    form.append("file", new File([payload], "Devon Cow Coding Mascot.png", { type: "image/png" }));
    const wire = new Request("http://localhost/api/workspace/upload", { method: "POST", body: form });
    const bytes = Buffer.from(await wire.arrayBuffer());
    const incoming = Readable.from((async function* () {
      yield bytes.subarray(0, 100);
      // A real network upload can still be arriving after the auth DB lookup.
      await new Promise(resolve => setTimeout(resolve, 10));
      yield bytes.subarray(100);
    })());
    Object.assign(incoming, { method: "POST", url: wire.url, headers: {
      "content-type": wire.headers.get("content-type"), origin: "http://localhost", cookie: "denchclaw_session=synthetic",
    } });
    const body = getCloneableBody(incoming, 26 * 1024 * 1024);
    const clone = body.cloneBodyStream();
    const request = new NextRequest(wire.url, {
      method: "POST", headers: (incoming as typeof incoming & { headers: HeadersInit }).headers,
      body: clone, duplex: "half",
    } as ConstructorParameters<typeof NextRequest>[1]);
    let finalizing: Promise<void> | undefined;
    try {
      const response = await (async () => {
        try {
          return await middleware(request);
        } finally {
          // Match next-server.js: do not await finalization, but return through
          // the async runner before constructing the app route's request.
          finalizing = body.finalize();
        }
      })();
      expect(response.headers.get("x-middleware-next")).toBe("1");
      const routeRequest = NextRequestAdapter.fromNodeNextRequest(new NodeNextRequest(incoming), new AbortController().signal);
      const uploaded = await POST(routeRequest);
      if (size > 25 * 1024 * 1024) {
        expect(uploaded.status).toBe(400);
        expect(await uploaded.json()).toEqual({ error: "File is too large (max 25 MB)" });
      } else {
        expect(uploaded.status).toBe(200);
        const result = await uploaded.json();
        expect(result.path).toMatch(/-Devon_Cow_Coding_Mascot\.png$/);
        expect(readFileSync(join(state.root, result.path)).equals(payload)).toBe(true);
      }
    } finally {
      await finalizing;
    }
  });
});
